"""Real DNS datagrams for the network namespace integration test."""
import concurrent.futures
import socket
import socketserver
import struct
import sys
import threading


def answer(query):
    # Test queries have one uncompressed question and no additional records.
    kind = struct.unpack("!H", query[-4:-2])[0]
    payload = {
        1: socket.inet_aton("203.0.113.77"),
        28: socket.inet_pton(socket.AF_INET6, "2001:db8::77"),
        16: b"\x06krotex",
    }.get(kind)
    response = query[:2] + struct.pack("!HHHHH", 0x8180, 1, int(payload is not None), 0, 0) + query[12:]
    if payload is not None:
        response += b"\xc0\x0c" + struct.pack("!HHIH", kind, 1, 60, len(payload)) + payload
    return response


def receive(sock, length):
    data = b""
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise RuntimeError("DNS TCP connection closed early")
        data += chunk
    return data


class UDPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        query, sock = self.request
        sock.sendto(answer(query), self.client_address)


class TCPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(3)
        try:
            while True:
                length = struct.unpack("!H", receive(self.request, 2))[0]
                response = answer(receive(self.request, length))
                self.request.sendall(struct.pack("!H", len(response)) + response)
        except (RuntimeError, TimeoutError):
            return


def make_query(index, kind):
    labels = ("q%d" % index, "device", "krotex", "test")
    name = b"".join(bytes([len(label)]) + label.encode() for label in labels) + b"\0"
    return struct.pack("!HHHHHH", index, 0x100, 1, 0, 0, 0) + name + struct.pack("!HH", kind, 1)


def probe(item):
    index, kind, transport, target = item
    query = make_query(index, kind)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM if transport == "tcp" else socket.SOCK_DGRAM) as sock:
        sock.settimeout(2)
        sock.connect((target, 53))
        if transport == "tcp":
            sock.sendall(struct.pack("!H", len(query)) + query)
            response = receive(sock, struct.unpack("!H", receive(sock, 2))[0])
        else:
            sock.send(query)
            response = sock.recv(4096)
        if response != answer(query):
            raise AssertionError("DNS response differs: id=%d type=%d %s" % (index, kind, transport))


def probe_shared_socket():
    expected = {}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(2)
        sock.connect(("192.168.55.1", 53))
        for index in range(200, 208):
            query = make_query(index, (1, 28, 16, 65)[index % 4])
            expected[index] = answer(query)
            sock.send(query)
        while expected:
            response = sock.recv(4096)
            ident = struct.unpack("!H", response[:2])[0]
            if response != expected.pop(ident):
                raise AssertionError("DNS shared-socket response differs: id=%d" % ident)


if sys.argv[1] == "serve":
    listen = sys.argv[2] if len(sys.argv) > 2 else "1.1.1.1"
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    tcp = socketserver.ThreadingTCPServer((listen, 53), TCPHandler)
    threading.Thread(target=tcp.serve_forever, daemon=True).start()
    with socketserver.ThreadingUDPServer((listen, 53), UDPHandler) as udp:
        udp.serve_forever()
else:
    # Exercise real UDP replies through Freedom/VLESS, with different client
    # ports, query types and original destinations rather than a DNS mock.
    items = [(i, (1, 28, 16, 65)[i % 4], "udp", ("1.1.1.1", "192.168.55.1")[i % 2]) for i in range(32)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(probe, items))
    for i, kind in enumerate((1, 28, 16, 65), start=100):
        probe((i, kind, "tcp", "192.168.55.1"))
    probe_shared_socket()
    print("PASS: parallel UDP, TCP and shared-socket DNS queries preserve IDs, A/AAAA/TXT/HTTPS answers and original destinations")
