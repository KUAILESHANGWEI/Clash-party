import { createReadStream } from 'fs'
import { copyFile, mkdir, rm, writeFile } from 'fs/promises'
import path from 'path'

const token = process.env.SYNC_GITHUB_TOKEN || process.env.GITHUB_TOKEN
const upstreamRepository = process.env.UPSTREAM_REPOSITORY || 'mihomo-party-org/clash-party'
const targetRepository = process.env.TARGET_REPOSITORY || 'KUAILESHANGWEI/clash-party'
const workDir = process.env.SYNC_WORKDIR || path.join(process.cwd(), '.release-sync')
const vendorTag = process.env.VENDOR_RELEASE_TAG || 'vendor'

if (!token) {
  throw new Error('SYNC_GITHUB_TOKEN or GITHUB_TOKEN is required')
}

const apiHeaders = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28'
}

async function gh(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...apiHeaders,
      ...options.headers
    }
  })
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${url} failed: ${res.status} ${await res.text()}`)
  }
  return res
}

async function ghJson(url, options = {}) {
  const res = await gh(url, options)
  return res.json()
}

async function getLatestRelease(repository) {
  return ghJson(`https://api.github.com/repos/${repository}/releases/latest`)
}

async function getReleaseByTag(repository, tagName) {
  const res = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tagName}`, {
    headers: apiHeaders
  })
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`GET target release failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function createRelease(repository, sourceRelease) {
  return ghJson(`https://api.github.com/repos/${repository}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: sourceRelease.tag_name,
      name: sourceRelease.name || sourceRelease.tag_name,
      body: `${sourceRelease.body || ''}\n\nMirrored from ${upstreamRepository}@${sourceRelease.tag_name}.`,
      draft: false,
      prerelease: sourceRelease.prerelease
    })
  })
}

async function ensureRelease(repository, tagName, name, body, prerelease = false) {
  const release = await getReleaseByTag(repository, tagName)
  if (release) {
    return ghJson(`https://api.github.com/repos/${repository}/releases/${release.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, body, draft: false, prerelease })
    })
  }
  return ghJson(`https://api.github.com/repos/${repository}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tagName, name, body, draft: false, prerelease })
  })
}

async function updateRelease(repository, release, sourceRelease) {
  return ghJson(`https://api.github.com/repos/${repository}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: sourceRelease.name || sourceRelease.tag_name,
      body: `${sourceRelease.body || ''}\n\nMirrored from ${upstreamRepository}@${sourceRelease.tag_name}.`,
      draft: false,
      prerelease: sourceRelease.prerelease
    })
  })
}

async function deleteAsset(asset) {
  await gh(`https://api.github.com/repos/${targetRepository}/releases/assets/${asset.id}`, {
    method: 'DELETE'
  })
}

async function downloadAsset(asset, filePath) {
  const res = await gh(asset.url, {
    headers: {
      Accept: 'application/octet-stream'
    }
  })
  await writeFile(filePath, Buffer.from(await res.arrayBuffer()))
}

async function downloadUrl(url, filePath) {
  const res = await fetch(url, { headers: { Accept: 'application/octet-stream' } })
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`)
  }
  await writeFile(filePath, Buffer.from(await res.arrayBuffer()))
}

async function uploadAsset(release, asset, filePath) {
  const uploadUrl = release.upload_url.replace('{?name,label}', '')
  const stat = await import('fs').then((fs) => fs.statSync(filePath))
  await gh(`${uploadUrl}?name=${encodeURIComponent(asset.name)}`, {
    method: 'POST',
    headers: {
      'Content-Type': asset.content_type || 'application/octet-stream',
      'Content-Length': String(stat.size)
    },
    body: createReadStream(filePath),
    duplex: 'half'
  })
}

async function mirrorAssets(release, assets) {
  const currentRelease = await getReleaseByTag(targetRepository, release.tag_name)
  const existingByName = new Map((currentRelease?.assets || []).map((asset) => [asset.name, asset]))
  for (const asset of assets) {
    const existing = existingByName.get(asset.name)
    if (existing) {
      await deleteAsset(existing)
    }
    const filePath = path.join(workDir, asset.name)
    if (asset.localPath) {
      await copyFile(asset.localPath, filePath)
    } else if (asset.apiAsset) {
      await downloadAsset(asset.apiAsset, filePath)
    } else {
      await downloadUrl(asset.url, filePath)
    }
    await uploadAsset(release, asset.apiAsset || asset, filePath)
    console.log(`mirrored ${asset.name}`)
  }
}

async function text(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`)
  return (await res.text()).trim()
}

async function vendorAssets() {
  const mihomoAlphaVersion = await text(
    'https://github.com/MetaCubeX/mihomo/releases/download/Prerelease-Alpha/version.txt'
  )
  const mihomoSmartVersion = await text(
    'https://github.com/vernesong/mihomo/releases/download/Prerelease-Alpha/version.txt'
  )
  const mihomoVersion = await text(
    'https://github.com/MetaCubeX/mihomo/releases/latest/download/version.txt'
  )
  const platforms = [
    ['win32-x64', 'mihomo-windows-amd64-compatible', 'zip'],
    ['win32-ia32', 'mihomo-windows-386', 'zip'],
    ['win32-arm64', 'mihomo-windows-arm64', 'zip'],
    ['darwin-x64', 'mihomo-darwin-amd64-compatible', 'gz'],
    ['darwin-arm64', 'mihomo-darwin-arm64', 'gz'],
    ['linux-x64', 'mihomo-linux-amd64-compatible', 'gz'],
    ['linux-arm64', 'mihomo-linux-arm64', 'gz']
  ]
  const smartPlatforms = [
    ['mihomo-windows-amd64-v2-go120', 'zip'],
    ['mihomo-windows-386-go120', 'zip'],
    ['mihomo-windows-arm64', 'zip'],
    ['mihomo-darwin-amd64-v2-go120', 'gz'],
    ['mihomo-darwin-arm64', 'gz'],
    ['mihomo-linux-amd64-v2-go120', 'gz'],
    ['mihomo-linux-arm64', 'gz']
  ]
  const sysproxyNodes = [
    'sysproxy.win32-x64-msvc.node',
    'sysproxy.win32-x64-msvc-win7.node',
    'sysproxy.win32-arm64-msvc.node',
    'sysproxy.win32-ia32-msvc.node',
    'sysproxy.win32-ia32-msvc-win7.node',
    'sysproxy.darwin-x64.node',
    'sysproxy.darwin-arm64.node',
    'sysproxy.linux-x64-musl.node',
    'sysproxy.linux-arm64-musl.node',
    'sysproxy.linux-x64-gnu.node',
    'sysproxy.linux-arm64-gnu.node'
  ]
  return [
    {
      name: 'mihomo-alpha-version.txt',
      url: 'https://github.com/MetaCubeX/mihomo/releases/download/Prerelease-Alpha/version.txt'
    },
    {
      name: 'mihomo-smart-version.txt',
      url: 'https://github.com/vernesong/mihomo/releases/download/Prerelease-Alpha/version.txt'
    },
    {
      name: 'mihomo-version.txt',
      url: 'https://github.com/MetaCubeX/mihomo/releases/latest/download/version.txt'
    },
    ...platforms.map(([, name, ext]) => ({
      name: `${name}-${mihomoAlphaVersion}.${ext}`,
      url: `https://github.com/MetaCubeX/mihomo/releases/download/Prerelease-Alpha/${name}-${mihomoAlphaVersion}.${ext}`
    })),
    ...platforms.map(([, name, ext]) => ({
      name: `${name}-${mihomoVersion}.${ext}`,
      url: `https://github.com/MetaCubeX/mihomo/releases/download/${mihomoVersion}/${name}-${mihomoVersion}.${ext}`
    })),
    ...smartPlatforms.map(([name, ext]) => ({
      name: `${name}-${mihomoSmartVersion}.${ext}`,
      url: `https://github.com/vernesong/mihomo/releases/download/Prerelease-Alpha/${name}-${mihomoSmartVersion}.${ext}`
    })),
    ...[
      'country-lite.mmdb',
      'geoip-lite.dat',
      'geoip.metadb',
      'geosite.dat',
      'geoip.dat',
      'GeoLite2-ASN.mmdb'
    ].map((name) => ({
      name,
      url: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/${name}`
    })),
    {
      name: 'enableLoopback.exe',
      url: 'https://github.com/Kuingsmile/uwp-tool/releases/download/latest/enableLoopback.exe'
    },
    ...sysproxyNodes.map((name) => ({
      name,
      url: `https://github.com/mihomo-party-org/sysproxy-rs-opti/releases/download/v0.1.0/${name}`
    })),
    ...['x64', 'ia32', 'arm64'].map((arch) => ({
      name: `monitor-${arch}.zip`,
      url: `https://github.com/mihomo-party-org/mihomo-party-run/releases/download/monitor/${arch}.zip`
    })),
    ...['x64', 'ia32', 'arm64'].map((arch) => ({
      name: `7za-${arch}.exe`,
      url: `https://github.com/develar/7zip-bin/raw/master/win/${arch}/7za.exe`
    })),
    {
      name: 'sub-store.bundle.js',
      url: 'https://github.com/sub-store-org/Sub-Store/releases/latest/download/sub-store.bundle.js'
    },
    ...['x64', 'arm64'].map((arch) => ({
      name: `party.mihomo.helper-${arch}`,
      url: `https://github.com/mihomo-party-org/mihomo-party-helper/releases/download/${arch}/party.mihomo.helper`
    })),
    {
      name: 'sub-store-frontend-dist.zip',
      url: 'https://github.com/sub-store-org/Sub-Store-Front-End/releases/latest/download/dist.zip'
    },
    {
      name: 'NotoColorEmoji.ttf',
      url: 'https://github.com/googlefonts/noto-emoji/raw/main/fonts/NotoColorEmoji.ttf'
    },
    {
      name: 'themes.zip',
      url: 'https://github.com/mihomo-party-org/theme-hub/releases/download/latest/themes.zip'
    }
  ]
}

await mkdir(workDir, { recursive: true })
try {
  const latest = await getLatestRelease(upstreamRepository)
  let target = await getReleaseByTag(targetRepository, latest.tag_name)
  target = target ? await updateRelease(targetRepository, target, latest) : await createRelease(targetRepository, latest)
  await mirrorAssets(
    target,
    [
      ...(latest.assets || []).map((apiAsset) => ({ name: apiAsset.name, apiAsset })),
      {
        name: 'install.sh',
        localPath: path.join(process.cwd(), 'install.sh'),
        content_type: 'application/x-sh'
      }
    ]
  )
  const vendorRelease = await ensureRelease(
    targetRepository,
    vendorTag,
    'Vendor assets mirror',
    'Mirrored build and runtime vendor assets used by this isolated repository.',
    true
  )
  await mirrorAssets(vendorRelease, await vendorAssets())
  console.log(`Release ${latest.tag_name} is mirrored to ${targetRepository}`)
} finally {
  await rm(workDir, { recursive: true, force: true })
}
