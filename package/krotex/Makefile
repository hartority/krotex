include $(TOPDIR)/rules.mk

PKG_NAME:=krotex
PKG_VERSION:=0.2.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/krotex
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Krotex service
  DEPENDS:=+xray-core
  PKGARCH:=all
endef

define Package/krotex/description
  Minimal procd-managed Xray service with a private configuration.
endef

define Package/krotex/conffiles
/etc/krotex/config.json
endef

define Build/Compile
endef

define Package/krotex/install
	$(INSTALL_DIR) $(1)/etc/init.d $(1)/etc/krotex
	$(INSTALL_BIN) ./files/krotex.init $(1)/etc/init.d/krotex
	$(INSTALL_CONF) ./files/config.json $(1)/etc/krotex/config.json
endef

$(eval $(call BuildPackage,krotex))
