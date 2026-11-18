FROM dunglas/frankenphp:1.13.5-php8.5.12-trixie
RUN install-php-extensions pdo_pgsql opcache \
 && cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY Caddyfile /etc/frankenphp/Caddyfile
COPY index.php /app/public/index.php
EXPOSE 8080
