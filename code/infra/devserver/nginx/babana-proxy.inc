# Headers for every proxied location. X-Forwarded-Proto is not decorative: odoo.conf sets
# proxy_mode = True and builds its URLs from it -- without it, Odoo answers with http:// links.
# X-Forwarded-For carries the client address that Odoo's per-IP limits (OTP, candidacy) count.
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_redirect off;
