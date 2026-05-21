#!/usr/bin/env sh
set -eu

REPO="KUAILESHANGWEI/clash-party"
API="https://api.github.com/repos/${REPO}/releases/latest"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need curl
need sed
need uname

os="$(uname -s)"
arch="$(uname -m)"

if [ "$os" != "Linux" ]; then
  echo "This installer currently supports Linux only." >&2
  exit 1
fi

case "$arch" in
  x86_64 | amd64) deb_arch="amd64"; rpm_arch="x86_64" ;;
  aarch64 | arm64) deb_arch="arm64"; rpm_arch="aarch64" ;;
  *)
    echo "Unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

release_json="$(curl -fsSL "$API")"
tag="$(printf '%s' "$release_json" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
version="${tag#v}"

if command -v dpkg >/dev/null 2>&1; then
  asset="clash-party-linux-${version}-${deb_arch}.deb"
  installer="dpkg -i"
elif command -v rpm >/dev/null 2>&1; then
  asset="clash-party-linux-${version}-${rpm_arch}.rpm"
  installer="rpm -Uvh"
else
  echo "Neither dpkg nor rpm was found." >&2
  exit 1
fi

url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
tmp="${TMPDIR:-/tmp}/${asset}"

curl -fL "$url" -o "$tmp"
if command -v sudo >/dev/null 2>&1; then
  sudo sh -c "$installer '$tmp'"
else
  sh -c "$installer '$tmp'"
fi
