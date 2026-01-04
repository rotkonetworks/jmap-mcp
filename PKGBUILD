# Maintainer: Rotko Networks <noc@rotko.net>
pkgname=jmapper
pkgver=0.1.0
pkgrel=1
pkgdesc="token-efficient jmap email cli for ai agents"
arch=('any')
url="https://github.com/niceyee/jmap-mcp"
license=('MIT')
depends=('deno')
source=("$pkgname-$pkgver.tar.gz::$url/archive/v$pkgver.tar.gz")
sha256sums=('SKIP')

package() {
    cd "$srcdir/jmap-mcp-$pkgver"
    install -Dm755 jmapper.ts "$pkgdir/usr/share/$pkgname/jmapper.ts"

    # wrapper script
    install -dm755 "$pkgdir/usr/bin"
    cat > "$pkgdir/usr/bin/jmapper" << 'EOF'
#!/bin/sh
exec deno run --allow-env --allow-net /usr/share/jmapper/jmapper.ts "$@"
EOF
    chmod 755 "$pkgdir/usr/bin/jmapper"
}
