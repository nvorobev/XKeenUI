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
# Строгий режим дополнительно блокирует INPUT/FORWARD/OUTPUT на всех портах при отсутствии
# свежей успешной проверки VPN. Аргумент «remove» снимает оба вида правил.

chain="xkeen_ui_guard"
# Новые правила собираются здесь и заменяют действующие, только когда добавлены все.
staging="${chain}_new"
xkeen_hook="${XKEEN_HOOK:-/opt/etc/ndm/netfilter.d/proxy.sh}"
guard_hook="${GUARD_HOOK:-/opt/etc/ndm/netfilter.d/90-xkeen-ui-guard.sh}"
guard_config="${GUARD_CONFIG:-/opt/etc/xkeen/traffic-guard.json}"
health_file="${GUARD_HEALTH:-/tmp/xkeen-ui-guard-health}"
strict_chain="xkeen_ui_lock"
strict_gate="xkeen_ui_gate"

is_strict() {
    [ -f "$guard_config" ] || return 1
    # An invalid config must not silently turn off strict protection.
    [ "$(sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$guard_config" 2>/dev/null | head -n 1)" != "proxy" ]
}

# Only the daemon's fresh successful VPN probe may open the gate. /tmp is reset at boot.
health_target() {
    [ -r "$health_file" ] || { echo DROP; return; }
    read -r health_pid health_until < "$health_file" 2>/dev/null || { echo DROP; return; }
    case "$health_pid:$health_until" in *[!0-9:]* | :* | *:) echo DROP; return ;; esac
    read -r uptime rest < "${GUARD_UPTIME:-/proc/uptime}"
    uptime="${uptime%%.*}"
    if kill -0 "$health_pid" 2>/dev/null && [ "$uptime" -lt "$health_until" ]; then echo RETURN; else echo DROP; fi
}

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

# Снимает переходы в цепочку и удаляет её.
drop_chain() {
    local family="$1" name="$2" parent
    for parent in FORWARD INPUT OUTPUT; do
        "$family" -w -S "$parent" 2>/dev/null | grep -- "-j $name\$" | sed 's/^-A /-D /' | while read -r rule; do
            # shellcheck disable=SC2086
            "$family" -w $rule >/dev/null 2>&1
        done
    done
    "$family" -w -F "$name" >/dev/null 2>&1
    "$family" -w -X "$name" >/dev/null 2>&1
    return 0
}

remove_family() {
    command -v "$1" >/dev/null 2>&1 || return 0
    drop_chain "$1" "$chain"
    drop_chain "$1" "$staging"
    remove_strict "$1"
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

# Strict protection covers both forwarded traffic and traffic intercepted by a local
# transparent proxy. Original destination checks preserve LAN access after REDIRECT/DNAT.
# Do not copy proxy.sh's public exclusions or port limits: those are Internet too.
remove_strict() {
    drop_chain "$1" "$strict_chain"
    drop_chain "$1" "${strict_chain}_new"
    "$1" -w -F "$strict_gate" >/dev/null 2>&1
    "$1" -w -X "$strict_gate" >/dev/null 2>&1
    return 0
}

sync_gate() {
    family="$1"
    command -v "$family" >/dev/null 2>&1 || return 1
    "$family" -w -C "$strict_gate" -j "$health_action" 2>/dev/null && return 0
    "$family" -w -R "$strict_gate" 1 -j "$health_action"
}

apply_strict() {
    local family="$1" name net local_nets parent
    # If IPv6 exists it must also be protected, even when XKeen does not proxy IPv6.
    command -v "$family" >/dev/null 2>&1 || {
        [ "$family" = "ip6tables" ] && [ ! -s /proc/net/if_inet6 ] && return 0
        return 1
    }
    if ! "$family" -w -S "$strict_gate" >/dev/null 2>&1; then
        "$family" -w -N "$strict_gate" || return 1
        "$family" -w -A "$strict_gate" -j DROP || return 1
    fi
    name="${strict_chain}_new"
    drop_chain "$family" "$name"
    "$family" -w -N "$name" || return 1
    if [ "$family" = "ip6tables" ]; then
        # Neighbor discovery is untracked; original-destination matches alone would
        # break IPv6 LAN access while the gate is closed. TCP/UDP REDIRECT still
        # uses the original destination checks below.
        for net in fe80::/10 fc00::/7 ff02::/16; do
            "$family" -w -A "$name" -p ipv6-icmp -d "$net" -j RETURN || return 1
        done
        "$family" -w -A "$name" -p udp -d ff02::/16 --sport 546 --dport 547 -j RETURN || return 1
        local_nets="::1/128 fe80::/10 fc00::/7 ff00::/8"
    else
        "$family" -w -A "$name" -p udp -d 255.255.255.255/32 --sport 68 --dport 67 -j RETURN || return 1
        local_nets="0.0.0.0/8 10.0.0.0/8 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 255.255.255.255/32"
    fi
    for net in $local_nets; do
        "$family" -w -A "$name" -m conntrack --ctorigdst "$net" -j RETURN || return 1
    done
    "$family" -w -A "$name" -j "$strict_gate" || return 1
    for parent in INPUT FORWARD OUTPUT; do
        # INPUT sees client requests to a transparent proxy; OUTPUT sees its replies.
        # Router-originated probes must remain possible, including their INPUT replies.
        case "$parent" in
            INPUT) set -- -m conntrack --ctdir ORIGINAL ;;
            OUTPUT) set -- -m conntrack --ctdir REPLY ;;
            *) set -- ;;
        esac
        # A TPROXY packet's fwmark may have been replaced; keep matching its connection mark.
        "$family" -w -I "$parent" 1 "$@" -m connmark --mark "$policy_mark" -j "$name" || return 1
        "$family" -w -I "$parent" 1 "$@" -m mark --mark "$policy_mark" -j "$name" || return 1
    done
    drop_chain "$family" "$strict_chain"
    "$family" -w -E "$name" "$strict_chain" || return 1
    sync_gate "$family"
}

# A tiny shell watchdog outlives the daemon. If it exits or gets stuck, a previously
# successful probe expires and closes the gate without any browser/firewall event.
if [ "$1" = "watch" ]; then
    unset type table
    watch_lock="${GUARD_WATCH_LOCK:-/tmp/xkeen-ui-guard-watch.lock}"
    if ! mkdir "$watch_lock" 2>/dev/null; then
        watch_wait=0
        watch_pid="$(cat "$watch_lock/pid" 2>/dev/null)"
        while [ -z "$watch_pid" ] && [ "$watch_wait" -lt 10 ]; do
            sleep 1
            watch_wait=$((watch_wait + 1))
            watch_pid="$(cat "$watch_lock/pid" 2>/dev/null)"
        done
        [ -n "$watch_pid" ] && kill -0 "$watch_pid" 2>/dev/null && exit 0
        rm -rf "$watch_lock"
        mkdir "$watch_lock" 2>/dev/null || exit 0
    fi
    echo $$ > "$watch_lock/pid"
    trap 'rm -rf "$watch_lock"' EXIT
    trap 'exit 0' INT TERM
    while [ -f "$guard_hook" ] && is_strict; do
        sh "$guard_hook" tick
        sleep 2
    done
    exit 0
fi

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
[ -f "$xkeen_hook" ] || is_strict || exit 0

policy_mark="$(read_var policy_mark)"
if [ -z "$policy_mark" ] && is_strict; then
    policy_mark="$(sed -n 's/.*"policy_mark"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$guard_config" 2>/dev/null | head -n 1)"
fi
# Без политики XKeen перехватывает всех клиентов, а это правило — только для политики.
[ -n "$policy_mark" ] || exit 0

port_donor="$(read_var port_donor)"
port_exclude="$(read_var port_exclude)"
if [ -n "$port_donor" ] && [ -n "$(read_var file_dns)" ]; then
    port_donor="$(read_var port_dns),$port_donor"
fi

health_action="$(health_target)"
if [ "$1" = "tick" ]; then
    # A watchdog already queued on the lock must not reinstall rules after Disable.
    [ -f "$guard_hook" ] || exit 0
    if is_strict; then
        # No repeated rule rebuilds in the steady state.
        for family in iptables ip6tables; do
            rebuild=false
            for parent in INPUT FORWARD OUTPUT; do
                case "$parent" in
                    INPUT) set -- -m conntrack --ctdir ORIGINAL ;;
                    OUTPUT) set -- -m conntrack --ctdir REPLY ;;
                    *) set -- ;;
                esac
                for match in connmark mark; do
                    "$family" -w -C "$parent" "$@" -m "$match" --mark "$policy_mark" -j "$strict_chain" >/dev/null 2>&1 || rebuild=true
                done
            done
            if [ "$rebuild" = true ]; then
                apply_strict "$family" || exit 1
            else
                sync_gate "$family" || exit 1
            fi
        done
    fi
    exit 0
fi

status=0
if [ -f "$xkeen_hook" ]; then
case "$type" in
    iptables | ip6tables) apply_family "$type" || status=1 ;;
    *)
        apply_family iptables || status=1
        apply_family ip6tables || status=1
        ;;
esac
fi
if is_strict; then
    for family in iptables ip6tables; do
        apply_strict "$family" || status=1
    done
    if [ "${GUARD_NO_WATCH:-0}" != "1" ]; then
        sh "$guard_hook" watch </dev/null >/dev/null 2>&1 &
    fi
else
    remove_strict iptables
    command -v ip6tables >/dev/null 2>&1 && remove_strict ip6tables
fi
exit $status
