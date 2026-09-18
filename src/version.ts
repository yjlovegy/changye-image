export const PLUGIN_VERSION = __BBI_VERSION__;

export function versionedAssetUrl(assetPath: string, baseUrl: string): string {
  const url = new URL(assetPath, baseUrl);
  url.searchParams.set('ver', PLUGIN_VERSION);
  const build = new URL(baseUrl).searchParams.get('build');
  if (build) url.searchParams.set('build', build);
  return url.href;
}
