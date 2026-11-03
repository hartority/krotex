include $(TOPDIR)/rules.mk

PKG_NAME:=krotex
PKG_VERSION:=0.5.2
PKG_RELEASE:=1
PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/krotex
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Krotex service
  DEPENDS:=+xray-core +jshn +ubus +firewall4 +nftables-json +ip-full +kmod-nft-tproxy +ucode +ucode-mod-fs
  PKGARCH:=all
endef

define Package/krotex/description
  Minimal procd-managed Xray service with a private configuration.
endef

define Package/krotex/conffiles
/etc/krotex/config.json
/etc/krotex/routing.json
endef

define Build/Compile
endef

define Package/krotex/install
	$(INSTALL_DIR) $(1)/etc/init.d $(1)/etc/krotex
	$(INSTALL_BIN) ./files/krotex.init $(1)/etc/init.d/krotex
	$(INSTALL_CONF) ./files/config.json $(1)/etc/krotex/config.json
	$(INSTALL_CONF) ./files/routing.json $(1)/etc/krotex/routing.json
	$(INSTALL_DIR) $(1)/usr/libexec/krotex $(1)/usr/share/krotex $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/firewall.sh $(1)/usr/libexec/krotex/firewall
	$(INSTALL_DATA) ./files/transparent.json $(1)/usr/share/krotex/transparent.json
	$(INSTALL_DATA) ./files/sections.uc $(1)/usr/share/krotex/sections.uc
	$(INSTALL_BIN) ./files/40-krotex-routing $(1)/etc/uci-defaults/40-krotex-routing
endef

$(eval $(call BuildPackage,krotex))
