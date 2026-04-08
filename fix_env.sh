#!/bin/bash
# Remove garbage lines from previous failed attempts
sed -i '/^_=/d' /var/www/myaura-v2/.env
sed -i '/^___=/d' /var/www/myaura-v2/.env
# Remove duplicates if they already exist
sed -i '/^PREMIUM_CONCURRENCY=/d' /var/www/myaura-v2/.env
sed -i '/^INTER_REQUEST_DELAY_MS=/d' /var/www/myaura-v2/.env
# Append correct values
echo "PREMIUM_CONCURRENCY=1" >> /var/www/myaura-v2/.env
echo "INTER_REQUEST_DELAY_MS=15000" >> /var/www/myaura-v2/.env
# Verify
echo "=== Last 5 lines of .env ==="
tail -5 /var/www/myaura-v2/.env
# Restart PM2
pm2 restart myaura-app --update-env
echo "=== Done ==="
