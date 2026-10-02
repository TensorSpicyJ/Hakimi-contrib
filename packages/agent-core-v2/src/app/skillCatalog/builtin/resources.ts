/**
 * `skillCatalog` domain — immutable text resources bundled with builtin skills.
 *
 * Skills contribute resources at module load; ordinary Read pagination can
 * open them without writing a second copy into a user's workspace.
 */

const resources = new Map<string, string>();

export function registerBuiltinResource(path: string, content: string): void {
  resources.set(path, content);
}

export function readBuiltinResource(path: string): string | undefined {
  try {
    const url = new URL(path);
    if (url.protocol !== 'builtin:' || url.search !== '') return undefined;
    url.hash = '';
    return resources.get(url.toString());
  } catch {
    return undefined;
  }
}
