"""Static file server for the harnesses: `python -m http.server PORT --bind ADDR --directory DIR`, minus its
reverse-DNS lookup. HTTPServer.server_bind() calls socket.getfqdn(host) between bind() and listen(); on a host whose
resolver never answers that PTR query (the Mac mini with Tailscale DNS: 35 s for 127.0.0.1 from Homebrew Python)
the port sits bound but not accepting, so Chromium's page load times out. The name is only cosmetic, so skip it.
"""
import argparse, functools, http.server, os, socketserver

ap = argparse.ArgumentParser()
ap.add_argument('port', type=int, nargs='?', default=8000)
ap.add_argument('--bind', '-b', default='127.0.0.1')
ap.add_argument('--directory', '-d', default=os.getcwd())
A = ap.parse_args()


class Server(http.server.ThreadingHTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=A.directory)
with Server((A.bind, A.port), handler) as srv:
    srv.serve_forever()
