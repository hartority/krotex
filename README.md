# Krotex

Маршрутизация трафика для OpenWrt.

## Установка

Выполните по SSH на роутере от `root`:

```sh
wget -O /tmp/krotex-install.sh https://raw.githubusercontent.com/hartority/krotex/main/install.sh && sh /tmp/krotex-install.sh
```

После установки откройте **Сервисы → Krotex** в LuCI.

## Обновление

Обновляет Krotex и нужную версию ядра Xray с сохранением настроек.

```sh
wget -O /tmp/krotex-update.sh https://raw.githubusercontent.com/hartority/krotex/main/update.sh && sh /tmp/krotex-update.sh
```
