"""Generate two independent local TLS/VLESS servers for namespace tests."""
import json
import sys
import ssl
import hashlib
from pathlib import Path

work = Path(sys.argv[1])
if len(sys.argv) > 2 and sys.argv[2] == "trust":
    # Xray uses its bundled trust roots. Pin the fixture certificate locally;
    # keep certificate verification enabled and leave host trust stores alone.
    cert = ssl.PEM_cert_to_DER_cert((work / "server.crt").read_text())
    pin = hashlib.sha256(cert).hexdigest()
    target = Path(sys.argv[3]) if len(sys.argv) > 3 else work / "sections-client.json"
    config = json.loads(target.read_text())
    for outbound in config["outbounds"]:
        tls = outbound.get("streamSettings", {}).get("tlsSettings")
        if tls is not None:
            tls["pinnedPeerCertSha256"] = pin
    config["log"]["loglevel"] = "debug"
    target.write_text(json.dumps(config))
    sys.exit(0)
uuid = "11111111-2222-4333-8444-555555555555"
profiles = []
for index, port in enumerate((2443, 2444), start=1):
    server = {
        "log": {"loglevel": "debug"},
        "dns": {"hosts": {"device.krotex.test": "203.0.113.77"}},
        "inbounds": [{"listen": "127.0.0.1", "port": port, "protocol": "vless",
                      "settings": {"clients": [{"id": uuid}], "decryption": "none"},
                      "streamSettings": {"network": "tcp", "security": "tls", "tlsSettings": {
                          "certificates": [{"certificateFile": str(work / "server.crt"), "keyFile": str(work / "server.key")}]
                      }}}],
        "outbounds": [{"tag": "direct", "protocol": "freedom"}, {"tag": "dns", "protocol": "dns"}],
        "routing": {"rules": [{"type": "field", "port": "5353", "outboundTag": "dns"}]}
    }
    (work / ("vpn%d.json" % index)).write_text(json.dumps(server))
    profiles.append({"id": uuid, "address": "127.0.0.1", "port": port, "security": "tls",
                     "server_name": "vpn.krotex.test", "fingerprint": "chrome", "public_key": "",
                     "short_id": "", "spider_x": "/", "flow": "", "alpn": ""})
sections = [
    {"id": "exclude", "name": "exclude", "enabled": True, "mode": "direct", "fallback": False,
     "domains": ["exclude.krotex.test", "overlap.krotex.test", "allowed.blocked.krotex.test"]},
    {"id": "vpn1", "name": "VPN 1", "enabled": True, "mode": "proxy", "fallback": False,
     "domains": ["one.krotex.test", "overlap.krotex.test"], "profile": profiles[0]},
    {"id": "vpn2", "name": "VPN 2", "enabled": True, "mode": "proxy", "fallback": True,
     "domains": ["two.krotex.test"], "profile": profiles[1]},
    {"id": "deny", "name": "Blocked domains", "enabled": True, "mode": "block", "fallback": False,
     "domains": ["blocked.krotex.test"]},
    {"id": "tv", "name": "TV VPN", "enabled": True, "mode": "proxy_devices", "fallback": False,
     "domains": [], "macs": ["02:66:77:88:99:aa"], "profile": profiles[0]}
]
(work / "sections-request.json").write_text(json.dumps({"sections": json.dumps(sections)}))
# The second variant has no default VPN: all unmatched traffic must be direct.
sections[2]["fallback"] = False
(work / "sections-direct-request.json").write_text(json.dumps({"sections": json.dumps(sections)}))
