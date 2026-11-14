"""Exercise generated Mux defaults with real TCP and concurrent UDP traffic."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import time

binary = os.environ["XRAY_TEST_BINARY"]
runtime = Path(os.environ["OPENWRT_TEST_ROOT"])
compiler = Path(__file__).resolve().parents[1] / "package/krotex/files/sections.uc"
loader = [str(runtime / "lib/ld-musl-x86_64.so.1"), "--library-path",
          f"{runtime}/lib:{runtime}/usr/lib", str(runtime / "usr/bin/ucode"),
          "-L", str(runtime / "usr/lib/ucode"), str(compiler)]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


with tempfile.TemporaryDirectory(prefix="krotex-mux-") as directory:
    work = Path(directory)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(work / "key"), "-out", str(work / "cert"),
                    "-subj", "/CN=localhost", "-days", "1"], capture_output=True, check=True)
    pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert((work / "cert").read_text())).hexdigest()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as echo:
        echo.bind(("127.0.0.1", 0))
        echo.settimeout(.2)
        stopped = threading.Event()

        def echo_packets():
            while not stopped.is_set():
                try:
                    data, address = echo.recvfrom(4096)
                    echo.sendto(data, address)
                except socket.timeout:
                    pass

        thread = threading.Thread(target=echo_packets)
        thread.start()
        try:
            for flow in ("", "xtls-rprx-vision"):
                server_port, socks_port, udp_port, http_port = [free_port() for _ in range(4)]
                profile = dict(id="11111111-2222-4333-8444-555555555555", address="127.0.0.1",
                               port=server_port, security="tls", server_name="localhost",
                               fingerprint="chrome", public_key="", short_id="", spider_x="/",
                               flow=flow, alpn="")
                section = dict(id="vpn", name="VPN", mode="proxy", enabled=True, fallback=True,
                               domains=[], profile=profile)
                (work / "saved.json").write_text('{"outbounds":[]}')
                (work / "request.json").write_text(json.dumps({"sections": json.dumps([section])}))
                client = json.loads(subprocess.check_output(
                    loader + ["compile", str(work / "saved.json"), str(work / "request.json")]))
                for outbound in client["outbounds"]:
                    if outbound["protocol"] == "vless":
                        outbound["streamSettings"]["tlsSettings"]["pinnedPeerCertSha256"] = pin
                        assert outbound["mux"] == dict(enabled=True, concurrency=-1 if flow else 32,
                                                       xudpConcurrency=256, xudpProxyUDP443="reject")
                client["inbounds"] = [
                    dict(tag="local-socks", listen="127.0.0.1", port=socks_port, protocol="socks"),
                    dict(tag="device-tproxy", listen="127.0.0.1", port=udp_port, protocol="dokodemo-door",
                         settings=dict(address="127.0.0.1", port=echo.getsockname()[1], network="udp"))]
                user = dict(id=profile["id"])
                if flow:
                    user["flow"] = flow
                server = dict(
                    inbounds=[dict(listen="127.0.0.1", port=server_port, protocol="vless",
                                   settings=dict(clients=[user], decryption="none"),
                                   streamSettings=dict(network="tcp", security="tls", tlsSettings=dict(
                                       certificates=[dict(certificateFile=str(work / "cert"),
                                                          keyFile=str(work / "key"))])))],
                    outbounds=[dict(protocol="freedom", settings=dict(
                        finalRules=[dict(action="allow", ip=["127.0.0.0/8"])]))])
                processes = []
                with open(work / "logs", "w+") as logs:
                    try:
                        processes.append(subprocess.Popen(
                            ["python3", "-m", "http.server", str(http_port), "--bind", "127.0.0.1"],
                            stdout=logs, stderr=logs))
                        for name, config in (("server", server), ("client", client)):
                            path = work / f"{name}.json"
                            path.write_text(json.dumps(config))
                            processes.append(subprocess.Popen(
                                [binary, "run", "-config", str(path)], stdout=logs, stderr=logs))
                        time.sleep(.6)
                        assert all(p.poll() is None for p in processes), "fixture failed to start"
                        result = subprocess.check_output([
                            "curl", "--silent", "--show-error", "--noproxy", "", "--proxy",
                            f"socks5h://127.0.0.1:{socks_port}", "--max-time", "5",
                            "-o", "/dev/null", "-w", "%{http_code}", f"http://127.0.0.1:{http_port}/"])
                        assert result == b"200", result

                        def probe(index):
                            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                                sock.settimeout(5)
                                for packet in range(4):
                                    data = f"{index}:{packet}:voice-packet".encode()
                                    sock.sendto(data, ("127.0.0.1", udp_port))
                                    assert sock.recv(4096) == data

                        with concurrent.futures.ThreadPoolExecutor(32) as pool:
                            list(pool.map(probe, range(32)))
                        print(f"PASS: Mux TCP and 128 UDP replies across 32 sessions ({flow or 'TLS'})",
                              flush=True)
                    except Exception:
                        logs.flush()
                        print((work / "logs").read_text())
                        raise
                    finally:
                        for process in processes:
                            process.terminate()
                        for process in processes:
                            process.wait()
        finally:
            stopped.set()
            thread.join()
