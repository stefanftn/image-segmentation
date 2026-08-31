# Maskwork frontend — plain static files (no build step), served by nginx.
#
# There's nothing to compile here: index.html, styles.css, and js/*.js are
# served exactly as they sit in this folder. The only thing containerizing
# this adds is a real static-file server in place of `python -m http.server`
# — so running it no longer depends on whoever's machine happens to have
# Python (or Node) installed.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html

EXPOSE 80
