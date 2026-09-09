// electron-builder afterPack hook
// Developer ID 인증서가 없을 때 앱 번들 전체를 ad-hoc 서명한다.
// 서명이 없으면 Apple Silicon에서 "손상되었기 때문에 열 수 없습니다" 오류가 난다.
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  })
  console.log(`  • ad-hoc signed  file=${appPath}`)
}
