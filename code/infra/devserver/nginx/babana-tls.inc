# One certificate for the four names (certbot --cert-name babana-devserver, README.md).
ssl_certificate     /etc/letsencrypt/live/babana-devserver/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/babana-devserver/privkey.pem;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_session_cache shared:babana_tls:10m;
ssl_session_timeout 1d;
add_header Strict-Transport-Security "max-age=31536000" always;
