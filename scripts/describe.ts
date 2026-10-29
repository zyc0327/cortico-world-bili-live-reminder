/**
 * 生成 describe.json。
 * Cortico checkout 里的 `pnpm describe:extension <dir>` 做同样的事;这里不依赖 checkout。
 * 用法:`corepack pnpm describe`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BILI_LIVE_REMINDER } from '../src/definition.ts';
import { text } from '../src/strings.ts';
import { WORLD_ID } from '../src/world.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const content = readFileSync(join(root, 'src', 'ENV_PROMPT.md'), 'utf8');
const doc = {
  tools: BILI_LIVE_REMINDER.describe?.tools ?? [],
  events: BILI_LIVE_REMINDER.describe?.events ?? [],
  prompts: [
    {
      key: `worlds.${WORLD_ID}.envPrompt`,
      title: text('zh').promptDocTitle,
      role: 'envPrompt',
      content,
    },
  ],
};

writeFileSync(join(root, 'describe.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log('wrote describe.json');
