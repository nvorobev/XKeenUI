#!/bin/sh
# XKeen UI: блокировка трафика мимо прокси.
# Файл создаёт и удаляет панель XKeen UI (Настройки → Защита трафика).
#
# Отбрасывает транзитный трафик устройств из политики XKeen на портах,
# которые XKeen должен проксировать, если он идёт в интернет напрямую.
# Пока прокси работает, такой трафик перехватывается в PREROUTING и в
# цепочку FORWARD не попадает, поэтому правило срабатывает только когда
# XKeen остановлен, ядро упало или роутер ещё загружается.
#
# Метка политики, порты и исключения берутся из хука XKeen (proxy.sh).
# Аргумент «remove» снимает правила.

chain="xkeen_ui_guard"
# Новые правила собираются здесь и заменяют действующие, только когда добавлены все.
staging="${chain}_new"
xkeen_hook="${XKEEN_HOOK:-/opt/etc/ndm/netfilter.d/proxy.sh}"

# XKeen пишет значения и в кавычках (port_donor="80,443"), и без них
# (ip6tables_supported=false).
read_var() {
    value="$(sed -n "s/^[[:space:]]*$1=//p" "$xkeen_hook" | head -n 1 | sed 's/[[:space:]]*$//')"
    value="${value#\"}"
    printf '%s' "${value%\"}"
}

# Список исключений XKeen задаёт отдельно для IPv4 и IPv6.
read_excludes() {
    if [ "$1" = "ip6tables" ]; then
        sed -n 's/^[[:space:]]*exclude_list="\([^"]*:[^"]*\)".*/\1/p' "$xkeen_hook" | head -n 1
    else
        sed -n 's/^[[:space:]]*exclude_list="\([^":]*\)".*/\1/p' "$xkeen_hook" | head -n 1
    fi
}

# Снимает переходы из FORWARD в цепочку и удаляет её.
drop_chain() {
    family="$1"
    name="$2"
    "$family" -w -S FORWARD 2>/dev/null | grep -- "-j $name\$" | sed 's/^-A /-D /' | while read -r rule; do
        # shellcheck disable=SC2086
        "$family" -w $rule >/dev/null 2>&1
    done
    "$family" -w -F "$name" >/dev/null 2>&1
    "$family" -w -X "$name" >/dev/null 2>&1
    return 0
}

remove_family() {
    command -v "$1" >/dev/null 2>&1 || return 0
    drop_chain "$1" "$chain"
    drop_chain "$1" "$staging"
}

# Добавляет правила для набора портов кусками: multiport принимает до 15 значений.
add_port_rules() {
    family="$1"
    name="$2"
    proto="$3"
    ports="$4"
    target="$5"
    echo "$ports" | tr ',' '\n' | sed '/^[[:space:]]*$/d' | {
        chunk=""
        count=0
        while read -r port; do
            chunk="${chunk:+$chunk,}$port"
            count=$((count + 1))
            if [ "$count" -eq 7 ]; then
                "$family" -w -A "$name" -p "$proto" -m multiport --dports "$chunk" -j "$target" || exit 1
                chunk=""
                count=0
            fi
        done
        if [ -n "$chunk" ]; then
            "$family" -w -A "$name" -p "$proto" -m multiport --dports "$chunk" -j "$target" || exit 1
        fi
    }
}

# Заполняет цепочку правилами блокировки.
fill_chain() {
    family="$1"
    name="$2"
    for net in $(read_excludes "$family"); do
        "$family" -w -A "$name" -d "$net" -j RETURN || return 1
    done
    # Ответы на проброшенные с WAN порты не трогаем.
    "$family" -w -A "$name" -m conntrack --ctstate DNAT -j RETURN || return 1

    for proto in $(read_var networks); do
        case "$proto" in
            tcp | udp) ;;
            *) continue ;;
        esac
        if [ -n "$port_donor" ]; then
            add_port_rules "$family" "$name" "$proto" "$port_donor" DROP || return 1
        else
            if [ -n "$port_exclude" ]; then
                add_port_rules "$family" "$name" "$proto" "$port_exclude" RETURN || return 1
            fi
            "$family" -w -A "$name" -p "$proto" -j DROP || return 1
        fi
    done
}

apply_family() {
    family="$1"
    command -v "$family" >/dev/null 2>&1 || return 0
    if [ "$(read_var "${family}_supported")" = "false" ]; then
        remove_family "$family"
        return 0
    fi

    # Правила собираются в отдельной цепочке: при сбое действующие остаются как были.
    drop_chain "$family" "$staging"
    "$family" -w -N "$staging" || return 1
    if ! fill_chain "$family" "$staging"; then
        drop_chain "$family" "$staging"
        return 1
    fi

    # Первым правилом FORWARD: раньше, чем ACCEPT для уже открытых соединений.
    # Переход ставится до снятия старой цепочки, чтобы не было окна без блокировки.
    if ! "$family" -w -I FORWARD 1 -m mark --mark "$policy_mark" -j "$staging"; then
        drop_chain "$family" "$staging"
        return 1
    fi
    # Старая цепочка уходит вместе со всеми переходами, в том числе с прежней меткой
    # политики: если политику XKeen пересоздали, ту метку Keenetic может отдать другой.
    drop_chain "$family" "$chain"
    # Переход из FORWARD следует за переименованной цепочкой.
    "$family" -w -E "$staging" "$chain"
}

# Keenetic вызывает хук на каждое событие firewall, панель — при включении: запуски
# не должны пересекаться, иначе один снимет правила, которые ставит другой.
lock="${GUARD_LOCK:-/tmp/xkeen-ui-guard.lock}"

# Блокировка брошена, если её хозяин завершился (PID пишется сразу после mkdir;
# пустая блокировка без PID дольше 10 с тоже считается брошенной).
lock_abandoned() {
    owner="$(cat "$lock/pid" 2>/dev/null)"
    if [ -n "$owner" ]; then
        ! kill -0 "$owner" 2>/dev/null
    else
        [ -d "$lock" ] && [ "$waited" -ge 10 ]
    fi
}

waited=0
reap_wait=0
until mkdir "$lock" 2>/dev/null; do
    waited=$((waited + 1))
    # Снимает брошенную блокировку только один процесс и перепроверяет хозяина под
    # своей блокировкой: иначе двое могли бы удалить уже новую блокировку друг друга.
    if lock_abandoned; then
        if mkdir "$lock.reap" 2>/dev/null; then
            lock_abandoned && rm -rf "$lock"
            rmdir "$lock.reap"
            waited=0
            reap_wait=0
            continue
        fi
        # Уборщик держит свою блокировку доли секунды; дольше 10 с — он завершился аварийно.
        reap_wait=$((reap_wait + 1))
        if [ "$reap_wait" -ge 10 ]; then
            rmdir "$lock.reap" 2>/dev/null
            reap_wait=0
        fi
    fi
    sleep 1
done
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT
trap 'exit 1' INT TERM

if [ "$1" = "remove" ]; then
    remove_family iptables
    remove_family ip6tables
    exit 0
fi

# Keenetic вызывает хук для каждой таблицы; нужна только filter.
[ -n "$table" ] && [ "$table" != "filter" ] && exit 0
[ -f "$xkeen_hook" ] || exit 0

policy_mark="$(read_var policy_mark)"
# Без политики XKeen перехватывает всех клиентов, а это правило — только для политики.
[ -n "$policy_mark" ] || exit 0

port_donor="$(read_var port_donor)"
port_exclude="$(read_var port_exclude)"
if [ -n "$port_donor" ] && [ -n "$(read_var file_dns)" ]; then
    port_donor="$(read_var port_dns),$port_donor"
fi

status=0
case "$type" in
    iptables | ip6tables) apply_family "$type" || status=1 ;;
    *)
        apply_family iptables || status=1
        apply_family ip6tables || status=1
        ;;
esac
exit $status
