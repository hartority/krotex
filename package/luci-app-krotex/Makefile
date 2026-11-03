include $(TOPDIR)/rules.mk

PKG_VERSION:=0.10.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT

LUCI_TITLE:=LuCI support for Krotex
LUCI_DEPENDS:=+luci-base +krotex +rpcd +jshn +ubus +curl +ca-bundle
LUCI_PKGARCH:=all

define Build/Prepare/luci-app-krotex
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/rpcd/krotex
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/krotex/connection
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/krotex/routing
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/krotex/sections
endef

include $(TOPDIR)/feeds/luci/luci.mk
