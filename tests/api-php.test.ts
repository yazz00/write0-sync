// Tests d'intégration de server/api.php, lancé avec le serveur intégré de PHP (php -S).
// Ignorés si PHP n'est pas installé.
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasPhp = spawnSync('php', ['-v']).status === 0;
const PORT = 18765;
const URL = `http://127.0.0.1:${PORT}/api.php`;
const PASSWORD = 'mot-de-passe-de-test';

let dir = '';
let server: ChildProcess | undefined;
let cookie = '';

async function call(action: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${URL}?action=${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Write0': '1', Cookie: cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: response.status, data: await response.json() };
}

const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const docFiles = () => fs.readdirSync(path.join(dir, 'docs')).sort();
const A = 'session-aaaaaaaa';
const B = 'session-bbbbbbbb';

describe.skipIf(!hasPhp)('server/api.php', () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write0-api-'));
    const hash = spawnSync('php', [
      '-r',
      `echo password_hash('${PASSWORD}', PASSWORD_DEFAULT);`,
    ]).stdout.toString();
    fs.writeFileSync(
      path.join(dir, 'config.php'),
      `<?php return ['password_hash' => '${hash}', 'secret' => 'secret-de-test'];`,
    );
    server = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', 'server'], {
      env: { ...process.env, WRITE0_DATA_DIR: dir },
      stdio: 'ignore',
    });
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${URL}?action=status`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  afterAll(() => {
    server?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuse tout sans connexion, et les requêtes sans en-tête anti-CSRF', async () => {
    expect((await call('poll', { session: A, since: 0 })).status).toBe(401);
    expect((await call('login', { password: PASSWORD }, { 'X-Write0': '' })).status).toBe(403);
    expect((await call('login', { password: 'faux' })).status).toBe(401);
    expect((await call('login', { password: PASSWORD })).status).toBe(200);
    expect((await call('status')).data).toEqual({ authenticated: true });
  });

  it('accorde la main à la première session et refuse les écritures des autres', async () => {
    expect((await call('acquire', { session: A, activeDoc: '' })).data.granted).toBe(true);
    expect((await call('acquire', { session: B, activeDoc: '' })).data.granted).toBe(false);
    const refused = await call('save', {
      session: B,
      doc: { id: 'x1', title: 'x', content: 'x', updatedAt: 1 },
    });
    expect(refused.status).toBe(409);
    expect((await call('poll', { session: A, since: 0 })).data.takeover).toBe(true);
    await call('release', { session: A });
    expect((await call('acquire', { session: B, activeDoc: '' })).data.granted).toBe(true);
    await call('release', { session: B });
    expect((await call('acquire', { session: A, activeDoc: '' })).data.granted).toBe(true);
  });

  it('fige un nom de fichier lisible dès que la première ligne est terminée', async () => {
    const save = (content: string, title: string) =>
      call('save', { session: A, doc: { id: 'doc-1234567890', title, content, updatedAt: 1 } });

    await save('Mon été', 'Mon été');
    expect(docFiles()).toEqual(['brouillon-doc-1234.md']);

    await save('Mon été à Paris !\nPremier jour.', 'Mon été à Paris !');
    expect(docFiles()).toEqual(['mon-ete-a-paris.md']);

    await save('Autre titre\nPremier jour.', 'Autre titre');
    expect(docFiles()).toEqual(['mon-ete-a-paris.md']);
    expect(fs.readFileSync(path.join(dir, 'docs', 'mon-ete-a-paris.md'), 'utf8')).toBe(
      'Autre titre\nPremier jour.',
    );

    await call('save', {
      session: A,
      doc: { id: 'doc-2', title: 'Mon été à Paris', content: 'Mon été à Paris\n', updatedAt: 2 },
    });
    expect(docFiles()).toEqual(['mon-ete-a-paris-2.md', 'mon-ete-a-paris.md']);
  });

  it('renvoie aux sessions passives les documents modifiés depuis leur révision', async () => {
    const all = (await call('poll', { session: B, since: 0 })).data;
    expect(all.owner).toBe(A);
    expect(all.ids.sort()).toEqual(['doc-1234567890', 'doc-2']);
    expect(all.changed).toHaveLength(2);
    const none = (await call('poll', { session: B, since: all.revision })).data;
    expect(none.changed).toEqual([]);
  });

  it('met les documents supprimés à la corbeille', async () => {
    await call('delete', { session: A, id: 'doc-2' });
    expect(docFiles()).toEqual(['mon-ete-a-paris.md']);
    const trash = fs.readdirSync(path.join(dir, 'trash'));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatch(/^mon-ete-a-paris-2--\d{4}-\d{2}-\d{2}_\d{6}\.md$/);
    expect((await call('poll', { session: B, since: 0 })).data.ids).toEqual(['doc-1234567890']);
  });

  it('purge la corbeille après 30 jours', async () => {
    const old = path.join(dir, 'trash', 'ancien--2026-01-01_000000.md');
    fs.writeFileSync(old, 'vieux');
    const date = new Date(Date.now() - 31 * 86400_000);
    fs.utimesSync(old, date, date);
    const s = state();
    s.purgedAt = 0;
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
    await call('delete', { session: A, id: 'inexistant' });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'trash'))).toHaveLength(1);
  });

  it('laisse la main à une autre session quand la session active ne répond plus', async () => {
    const s = state();
    s.lock.beat -= 11_000;
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
    expect((await call('acquire', { session: B, activeDoc: '' })).data.granted).toBe(true);
    const late = await call('save', {
      session: A,
      doc: { id: 'doc-1234567890', title: 't', content: 'perdu', updatedAt: 3 },
    });
    expect(late.status).toBe(409);
  });

  it('refuse les identifiants dangereux', async () => {
    const bad = await call('save', {
      session: B,
      doc: { id: '../../etc/passwd', title: 'x', content: 'x', updatedAt: 1 },
    });
    expect(bad.status).toBe(400);
    expect((await call('poll', { session: '../x', since: 0 })).status).toBe(400);
  });

  it('nomme le fichier dès la création quand le texte a reçu un nom', async () => {
    await call('save', {
      session: B,
      doc: {
        id: 'doc-3',
        title: 'Journal de novembre',
        hasCustomTitle: true,
        content: '',
        updatedAt: 3,
      },
    });
    expect(docFiles()).toContain('journal-de-novembre.md');
    await call('delete', { session: B, id: 'doc-3' });
  });
});
