#!/bin/sh

GREEN=$'\033[32m'
GREEN_BOLD=$'\033[1;32m'
RED=$'\033[31m'
RED_BOLD=$'\033[1;31m'
NC=$'\033[0m'
NCN="$NC\n\n"
BLUE=$'\033[1;34m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[1;96m'

ERROR="\n${RED} ❌${RED_BOLD}"
SUCCESS="\n${GREEN} ✅${GREEN_BOLD}"
INFO="\n${CYAN} ℹ️ "

XKEENUI_BIN="/opt/sbin/xkeen-ui"
XKEENUI_INIT="/opt/etc/init.d/S99xkeen-ui"
TRAFFIC_GUARD_HOOK="/opt/etc/ndm/netfilter.d/90-xkeen-ui-guard.sh"
STATIC_DIR="/opt/share/www/XKeen-UI"
LIGHTTPD_INIT="/opt/etc/init.d/S80lighttpd"
LIGHTTPD_DIR="/opt/etc/lighttpd"
LIGHTTPD_CONF="$LIGHTTPD_DIR/conf.d/90-xkeenui.conf"

BETA=false
LOCAL=false
ACTION=""
PORT=""
GUARD=""
ASSUME_YES=false
XKEEN_HOOK="/opt/etc/ndm/netfilter.d/proxy.sh"
APP_CONFIG="/opt/etc/xkeen/xkeen-ui.json"

usage() {
  cat <<'USAGE'
Использование: setup.sh [действие] [параметры]

Действия (без них показывается меню):
  install     установить или переустановить
  update      обновить
  uninstall   удалить

Параметры установки:
  --port N    порт панели (по умолчанию 1000 или прежний)
  --guard     включить блокировку трафика мимо прокси
  --no-guard  выключить её
  -y, --yes   ничего не спрашивать: чего нет в параметрах, остаётся как есть
  beta        ставить бета-версию

Пароль admin задаётся переменной окружения XKEEN_UI_PASSWORD, чтобы он
не попал в историю команд. Пример:
  read -rs XKEEN_UI_PASSWORD; export XKEEN_UI_PASSWORD
  curl -fsSL https://raw.githubusercontent.com/nvorobev/XKeenUI/main/setup.sh | sh -s -- install --port 8080 --guard -y
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    beta|--beta) BETA=true;;
    install|--install) ACTION=1;;
    update|--update) ACTION=2;;
    uninstall|--uninstall) ACTION=3;;
    --port) PORT="$2"; shift;;
    --port=*) PORT="${1#--port=}";;
    --guard) GUARD=on;;
    --no-guard) GUARD=off;;
    -y|--yes) ASSUME_YES=true;;
    -h|--help) usage; exit 0;;
    *) printf "Неизвестный параметр: %s\n\n" "$1"; usage; exit 1;;
  esac
  shift
done

valid_port() {
  case "$1" in ''|*[!0-9]*) return 1;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

if [ -n "$PORT" ] && ! valid_port "$PORT"; then
  printf "Некорректный порт: %s\n" "$PORT"
  exit 1
fi

spinner() {
  local pid=$1 msg=$2
  trap 'kill "$pid" 2>/dev/null; printf "\r${RED} ❌ ${NC}%s\033[K\n" "$msg"; printf "\033[?25h"; return 130' INT
  set -- ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
  printf "\033[?25l"
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r${GREEN} %s ${NC} %s\033[K" "$1" "$msg"
    set -- "$@" "$1"
    shift
    usleep 100000
  done
  printf "\033[?25h"
  wait "$pid" && printf "\r ✔  %s\033[K\n" "$msg" || { printf "\r ❌ %s\033[K\n" "$msg"; return 1; }
}

get_arch() {
  case "$(opkg print-architecture)" in
    *aarch64*) ARCH='arm64-v8a' ;;
    *mipsel*)  ARCH='mips32le' ;;
    *mips*)    ARCH='mips32' ;;
    *) printf "${RED_BOLD}\n Не удалось определить архитектуру.${NCN}" >&2; exit 1 ;;
  esac
}

# Resumable download: progress bar, aborts a stalled transfer (<1 KB/s for 30 s), up to 3 attempts.
fetch() {
  local url=$1 out=$2 quiet=$3 attempt=1 progress="--progress-bar"
  [ -n "$quiet" ] && progress="-sS"
  while :; do
    curl -fL $progress --connect-timeout 15 --speed-limit 1024 --speed-time 30 -C - "$url" -o "$out" && return 0
    [ "$attempt" -ge 3 ] && return 1
    attempt=$((attempt + 1))
    printf "${YELLOW} Соединение прервалось, попытка %s из 3...${NC}\n" "$attempt"
    sleep 3
  done
}

download_files() {
  local base_url="https://github.com/nvorobev/XKeenUI/releases"
  local download_url="$base_url/latest/download"
  local bin_name="xkeen-ui-$ARCH"
  local download_dir install_dir version=""
  install_dir=$(dirname "$XKEENUI_BIN")
  mkdir -p "$install_dir" /opt/tmp || exit 1
  download_dir=$(mktemp -d "$install_dir/.xkeen-ui-install.XXXXXX") || exit 1
  trap 'rm -rf "$download_dir"' EXIT

  if [ "$BETA" = true ]; then
    local beta_tag
    beta_tag=$(curl -fLsS --connect-timeout 15 --max-time 60 https://api.github.com/repos/nvorobev/XKeenUI/releases | \
      jq -re 'map(select(.prerelease == true and .draft == false)) | first | .tag_name // empty') || {
      printf "${RED_BOLD}\n Нет доступного бета-релиза${NCN}"
      [ -x "$XKEENUI_INIT" ] && "$XKEENUI_INIT" start >/dev/null 2>&1 || :
      exit 1
    }
    download_url="$base_url/download/$beta_tag"
    version=$beta_tag
  else
    # /releases/latest redirects to /releases/tag/<version>: show and pin that exact version.
    version=$(curl -fsSIL --connect-timeout 15 --max-time 30 -o /dev/null -w '%{url_effective}' "$base_url/latest" | sed -n 's#.*/tag/##p')
    [ -n "$version" ] && download_url="$base_url/download/$version"
  fi
  if [ "$LOCAL" = true ] && [ -f "/opt/tmp/$bin_name" ]; then
    printf "${INFO}Устанавливается локальный файл /opt/tmp/%s${NCN}" "$bin_name"
  else
    printf "${INFO}Устанавливается версия: ${GREEN_BOLD}%s${NC} (%s)${NCN}" "${version:-последний релиз}" "$ARCH"
  fi

  if [ "$LOCAL" = true ] && [ -f "/opt/tmp/$bin_name" ]; then
    cp "/opt/tmp/$bin_name" "$download_dir/$bin_name" || exit 1
  else
    printf " Загрузка %s...\n" "$bin_name"
    if ! fetch "$download_url/SHA256SUMS" "$download_dir/SHA256SUMS" quiet || ! fetch "$download_url/$bin_name" "$download_dir/$bin_name"; then
      printf "${RED_BOLD}\n Не удалось скачать релиз (нет связи с GitHub или слишком медленно). Прежний бинарник сохранён.${NCN}"
      [ -x "$XKEENUI_INIT" ] && "$XKEENUI_INIT" start >/dev/null 2>&1 || :
      exit 1
    fi
    if ! (
      cd "$download_dir" &&
        awk -v file="$bin_name" '$2 == file || $2 == "*" file { print $1 "  " file; found=1 } END { if (!found) exit 1 }' SHA256SUMS > selected.sha256 &&
        sha256sum -c selected.sha256 >/dev/null
    ); then
      printf "${RED_BOLD}\n Контрольная сумма не совпала — файл повреждён. Прежний бинарник сохранён.${NCN}"
      [ -x "$XKEENUI_INIT" ] && "$XKEENUI_INIT" start >/dev/null 2>&1 || :
      exit 1
    fi
    printf " ✔  Бинарник загружен и проверен\n"
  fi
  chmod 755 "$download_dir/$bin_name" || exit 1
  # Rename on the same filesystem: failed downloads never truncate the installed binary.
  mv -f "$download_dir/$bin_name" "$XKEENUI_BIN" || exit 1
  [ "$LOCAL" = true ] && rm -f "/opt/tmp/$bin_name"
  rm -rf "$download_dir"
  trap - EXIT
}

install_xkeenui() {
  if [[ -d $STATIC_DIR || -f $XKEENUI_BIN || -f $XKEENUI_INIT || -f $LIGHTTPD_CONF ]]; then
    printf "${YELLOW}\n Обнаружены файлы XKeen UI, запуск переустановки...\n${NC}"
    stop_xkeenui
    legacy_installation_check
  fi

  ask_install_options

  printf "${INFO} Начинаем установку...${NCN}"

  [ -f "/opt/tmp/xkeen-ui-$ARCH" ] && LOCAL=true

  download_files
  # Settings (xkeen-ui.json, Xray server pool) are kept; the init script is refreshed with the same ARGS.
  create_xkeenui_init

  if [ -n "$XKEEN_UI_PASSWORD" ]; then
    if ! XKEEN_UI_PASSWORD="$XKEEN_UI_PASSWORD" $XKEENUI_BIN set-password >/dev/null; then
      printf "${ERROR} Не удалось задать пароль admin.${NCN}"
      exit 1
    fi
  fi

  sync & spinner $! "Запись данных..."

  $XKEENUI_INIT start &>/dev/null &
  if ! spinner $! "Запуск XKeen UI..."; then
    printf "${RED_BOLD}\n Не удалось запустить XKeen UI.${NCN}"
    exit 1
  fi

  apply_guard_choice
  finish_setup "установлен"
}

current_port() {
  local port=$(sed -n 's/.*-p \([0-9]*\).*/\1/p' $XKEENUI_INIT 2>/dev/null | head -n 1)
  printf '%s' "${port:-1000}"
}

has_password() {
  grep -q '"password_hash"[[:space:]]*:[[:space:]]*"' "$APP_CONFIG" 2>/dev/null
}

# XKeen работает через политику доступа: только тогда есть что блокировать.
xkeen_has_policy() {
  grep -q '^[[:space:]]*policy_mark="\{0,1\}0x' "$XKEEN_HOOK" 2>/dev/null
}

read_secret() {
  local value
  stty -echo < /dev/tty 2>/dev/null
  read -r value < /dev/tty
  stty echo < /dev/tty 2>/dev/null
  printf '\n' > /dev/tty
  printf '%s' "$value"
}

ask_install_options() {
  [ "$ASSUME_YES" = true ] && return

  if [ -z "$PORT" ]; then
    local default_port=$(current_port) answer
    while :; do
      read -p " Порт панели [$default_port]: " answer < /dev/tty
      answer=${answer:-$default_port}
      valid_port "$answer" && break
      printf "${RED} Порт — число от 1 до 65535.${NC}\n"
    done
    [ "$answer" != "$default_port" ] && PORT=$answer
  fi

  if [ -z "$XKEEN_UI_PASSWORD" ]; then
    local hint="Enter — admin" first second
    has_password && hint="Enter — оставить текущий"
    while :; do
      printf " Пароль admin ($hint): " > /dev/tty
      first=$(read_secret)
      [ -z "$first" ] && break
      printf " Повторите пароль: " > /dev/tty
      second=$(read_secret)
      [ "$first" = "$second" ] && { XKEEN_UI_PASSWORD=$first; break; }
      printf "${RED} Пароли не совпали, попробуйте ещё раз.${NC}\n"
    done
  fi

  if [ -z "$GUARD" ] && xkeen_has_policy; then
    local answer
    printf "\n Блокировать трафик мимо прокси? Если XKeen не работает, устройства из его\n"
    printf " политики не выйдут в интернет напрямую на проксируемых портах.\n"
    read -p " Включить? [y/N]: " answer < /dev/tty
    case "$answer" in [Yy]*) GUARD=on;; esac
  fi
}

apply_guard_choice() {
  [ -z "$GUARD" ] && return
  if ! $XKEENUI_BIN traffic-guard "$GUARD" >/dev/null 2>&1; then
    printf "${YELLOW}\n Не удалось изменить блокировку трафика мимо прокси; это можно сделать в настройках панели.\n${NC}"
  fi
}

update_xkeenui() {
  [ -f "$XKEENUI_BIN" ] || { printf "${ERROR} Ошибка: XKeen UI не установлен!${NCN}"; exit 1; }

  printf "${INFO} Начинаем обновление...${NCN}"

  if [ ! -f $XKEENUI_INIT ]; then
    (
      set -e
      killall -q -9 xkeen-ui &>/dev/null || :
      create_xkeenui_init
    ) &
    spinner $! "Создание скрипта запуска..."
  elif pidof xkeen-ui &>/dev/null; then
    (
      sed -i 's|^PROCS=/opt/sbin/xkeen-ui$|PROCS=xkeen-ui|' /opt/etc/init.d/S99xkeen-ui
      $XKEENUI_INIT stop &>/dev/null || :
      killall -q -9 xkeen-ui || :
    ) &
    spinner $! "Остановка XKeen UI..."
  else
    sed -i 's|^PROCS=/opt/sbin/xkeen-ui$|PROCS=xkeen-ui|' /opt/etc/init.d/S99xkeen-ui
  fi

  chmod +x "$XKEENUI_INIT" || exit 1

  legacy_installation_check; download_files

  sync & spinner $! "Запись данных..."

  $XKEENUI_INIT start &>/dev/null &
  if ! spinner $! "Запуск XKeen UI..."; then
    printf "${RED_BOLD}\n Не удалось запустить XKeen UI.${NCN}"
    exit 1
  fi

  finish_setup "обновлен"
}

stop_xkeenui() {
  if [ -x "$XKEENUI_INIT" ]; then "$XKEENUI_INIT" stop >/dev/null 2>&1 || :; fi
  killall -q -9 xkeen-ui >/dev/null 2>&1 || :
}

# Return user routing/api that the "Xray servers" window moved into its managed config.
restore_xray_servers() {
  [ -x "$XKEENUI_BIN" ] || return 0
  "$XKEENUI_BIN" --help 2>/dev/null | grep -q disable-xray-servers || return 0
  "$XKEENUI_BIN" disable-xray-servers
}

uninstall_xkeenui() {
  printf "\n Данное действие ${RED_BOLD}удалит${NC} XKeen UI, его файлы и зависимости.\n\n"
  read -p " Продолжить? [y/N]: " response < /dev/tty
  response=$(printf '%s' "$response" | tr -cd 'YyNn')
  case "$response" in
    [Yy]) printf "${INFO} Начинаем удаление...${NCN}";;
    *) printf "${ERROR} Отмена операции.${NCN}"; exit 1;;
  esac

  (
    if [[ -f "$LIGHTTPD_INIT" && -f "$LIGHTTPD_CONF" ]]; then
      if $LIGHTTPD_INIT status &>/dev/null; then
          $LIGHTTPD_INIT stop &>/dev/null || :
          opkg remove --autoremove --force-removal-of-dependent-packages lighttpd &>/dev/null
          rm -rf $LIGHTTPD_DIR
      fi
    fi
    if [ -f $XKEENUI_INIT ]; then
      if $XKEENUI_INIT status &>/dev/null; then
        $XKEENUI_INIT stop &>/dev/null || :
        killall -q -9 xkeen-ui || :
      fi
    fi
  ) &
  spinner $! "Остановка XKeen UI..."

  if ! restore_xray_servers; then
    printf "${ERROR} Не удалось вернуть исходные настройки Xray. Удаление остановлено, файлы панели сохранены.${NCN}"
    [ -x "$XKEENUI_INIT" ] && "$XKEENUI_INIT" start >/dev/null 2>&1 || :
    exit 1
  fi

  if [ -f "$TRAFFIC_GUARD_HOOK" ]; then
    (sh "$TRAFFIC_GUARD_HOOK" remove >/dev/null 2>&1 || :; rm -f "$TRAFFIC_GUARD_HOOK") &
    spinner $! "Снятие блокировки трафика мимо прокси..."
  fi

  (rm -rf $STATIC_DIR; rm -f $XKEENUI_BIN $XKEENUI_INIT /opt/etc/xkeen/xray-servers.json /opt/etc/xkeen/xray-servers-transaction.json /opt/etc/xkeen/xray-server-library.json) &
  spinner $! "Удаление файлов XKeen UI..."
  printf "${SUCCESS} Удаление XKeen UI завершено${NCN}"
}

finish_setup() {
  local ip=$(ip -4 a s br0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p'); ip=${ip:-"IP_Роутера"}
  local port=$(sed -n 's/.*-p \([0-9]*\).*/\1/p' $XKEENUI_INIT 2>/dev/null); port=${port:-1000}

  printf "${SUCCESS} XKeen UI успешно $1!${NCN}"
  printf " Панель доступна по адресу: ${GREEN_BOLD}http://$ip:$port${NC}\n"
  if [ "$1" = "установлен" ] && [ -z "$XKEEN_UI_PASSWORD" ]; then
    printf " Если пароль admin не менялся, вход: ${GREEN_BOLD}admin${NC} / ${GREEN_BOLD}admin${NC} — смените его в разделе «Пользователи».\n"
  fi
  printf "\n"
}

legacy_installation_check() {
  if [ -f "$LIGHTTPD_CONF" ]; then
    $LIGHTTPD_INIT status &>/dev/null && $LIGHTTPD_INIT stop
    rm -f "$LIGHTTPD_CONF"
    printf "${YELLOW}\n Веб-сервер lighttpd для работы XKeen UI более не используется.\n${NC}"
    read -p " Удалить его? [Y/n]: " response < /dev/tty
    response=$(printf '%s' "$response" | tr -cd 'YyNn')
    case "$response" in
      [Nn]) return;;
      *) opkg remove --autoremove --force-removal-of-dependent-packages lighttpd; rm -rf $LIGHTTPD_DIR;;
    esac
  fi
}

create_xkeenui_init() {
  local args="-p 1000" enabled=yes old_args old_enabled
  if [ -f "$XKEENUI_INIT" ]; then
    old_args=$(sed -n 's/^ARGS="\(.*\)"$/\1/p' "$XKEENUI_INIT" | head -n 1)
    [ -n "$old_args" ] && args=$old_args
    old_enabled=$(sed -n 's/^ENABLED=//p' "$XKEENUI_INIT" | head -n 1)
    case "$old_enabled" in yes|no) enabled=$old_enabled;; esac
  fi
  if [ -n "$PORT" ]; then
    case "$args" in
      *"-p "*) args=$(printf '%s' "$args" | sed "s/-p [0-9]*/-p $PORT/");;
      *) args="$args -p $PORT";;
    esac
  fi
  cat << EOF > $XKEENUI_INIT
#!/bin/sh

ENABLED=$enabled
PROCS=xkeen-ui
ARGS="$args"
PREARGS=""
DESC="\$PROCS"
PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

printf '[INIT] action=%s date=%s\n' "\${1:-start}" "\$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> /opt/var/log/xkeen-ui.log 2>/dev/null || :
. /opt/etc/init.d/rc.func
EOF
  chmod +x $XKEENUI_INIT
}

get_status() {
  [ ! -f "$XKEENUI_BIN" ] && printf "Статус панели: ${RED_BOLD}не установлена${NC}" && return

  local version=$($XKEENUI_BIN -v 2>/dev/null | awk 'NR==1{print $3}')
  local status="${RED_BOLD}не запущена"

  version=${version:-"N/A"}

  pidof xkeen-ui &>/dev/null && status="${GREEN_BOLD}запущена"
  printf "Статус панели: $status ${NC}[$version]"
}

clear
get_arch
printf "\n${CYAN} XKeen UI${NC} — установка и обновление панели\n"

printf "${NC}\n$(get_status)\n"
printf "Архитектура: ${GREEN_BOLD}$ARCH\n"
printf "\nДобро пожаловать! Выберите действие:${NCN}"
printf "  1. Установить/переустановить\n"
printf "  2. Обновить\n"
printf "  3. Удалить\n"
printf "\n  0. Выйти\n\n"

if [ -n "$ACTION" ]; then
  response=$ACTION
else
  read -p "${GREEN_BOLD}>: ${NC}" response < /dev/tty
fi

case $response in
  1) install_xkeenui;;
  2) update_xkeenui;;
  3) uninstall_xkeenui;;
  0) echo; exit;;
  *) printf "${ERROR} Неверный выбор.${NCN}"; exit 1;;
esac
