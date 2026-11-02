# nginx load balancer + dashboard. Build from the repo root:
#   docker build -f gateway/Dockerfile -t rate-limit-gateway .
FROM nginx:1.28-alpine
ENV NGINX_RESOLVER=127.0.0.11 \
    API_HOST=api
COPY gateway/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY dashboard/ /usr/share/nginx/html/
