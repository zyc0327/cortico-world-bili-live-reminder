import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import extension from '../src/index.ts';

const root = new URL('..', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  type?: string;
  main?: string;
  keywords?: string[];
  files?: string[];
  cortico?: {
    kind?: string;
    api?: number;
    icon?: string;
    describe?: string;
    webUiClient?: string;
  };
};

describe('package manifest', () => {
  it('入口默认导出这个 World', () => {
    expect(extension.id).toBe('bili-live-reminder');
    expect(extension.label).toBe('B 站开播提醒');
  });

  it('是 World 扩展,带 cortico-world 关键字与 api 6', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('./src/index.ts');
    expect(pkg.keywords).toContain('cortico-world');
    expect(pkg.cortico).toMatchObject({ kind: 'world', api: 6 });
  });

  it('入口、图标、describe 与面板产物都在,且 files 会把它们发出去', () => {
    expect(existsSync(new URL(pkg.main!, root))).toBe(true);
    expect(existsSync(new URL(pkg.cortico!.icon!, root))).toBe(true);
    expect(existsSync(new URL(pkg.cortico!.describe!, root))).toBe(true);
    expect(existsSync(new URL(pkg.cortico!.webUiClient!, root))).toBe(true);
    expect(pkg.files).toContain('src');
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('assets');
    expect(pkg.files).toContain('describe.json');
  });
});
