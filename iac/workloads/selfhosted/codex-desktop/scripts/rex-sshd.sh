#!/usr/bin/with-contenv bash
set -euo pipefail

install -d -o root -g root -m 0755 /run/sshd
cat > /run/rex-sshd.conf <<'EOF'
Port 2222
HostKey /config/.ssh/rex-host/ssh_host_ed25519_key
AuthorizedKeysFile /etc/ssh/rex-authorized-keys
AllowUsers abc
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
PubkeyAuthentication yes
UsePAM yes
PidFile /run/rex-sshd.pid
Subsystem sftp internal-sftp
EOF
exec /usr/sbin/sshd -D -e -f /run/rex-sshd.conf
