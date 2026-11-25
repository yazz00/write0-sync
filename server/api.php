<?php
// write0 — API de sauvegarde (un seul utilisateur, sans base de données).
//
// Une seule session (onglet) a la main à la fois : elle seule peut enregistrer ou supprimer.
// Les autres sessions interrogent le serveur (poll) pour suivre le texte, et demandent la main
// (acquire) au premier clic ; la session active termine alors ses envois et la rend (release).
//
// Données : DATA_DIR/state.json (révision, verrou, index des documents),
//           DATA_DIR/docs/<nom-lisible>.md, DATA_DIR/trash/ (purgé après 30 jours).

define('DATA_DIR', getenv('WRITE0_DATA_DIR') ?: dirname(__DIR__, 2) . '/write0-data');
const COOKIE = 'w0auth';
const SESSION_DAYS = 30;
const MAX_BODY = 5 * 1024 * 1024;
const OWNER_TIMEOUT_MS = 10000;   // session active muette depuis 10 s : considérée partie
const TAKEOVER_WAIT_MS = 10000;   // délai max d'attente de la passation
const TRASH_DAYS = 30;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function reply(int $code, array $data): never {
  http_response_code($code);
  echo json_encode($data, JSON_UNESCAPED_UNICODE);
  exit;
}

$configFile = DATA_DIR . '/config.php';
if (!is_file($configFile)) reply(500, ['error' => 'not_configured']);
$config = require $configFile;

// --- Authentification --------------------------------------------------------------------

function is_https(): bool {
  return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

function authenticated(array $config): bool {
  [$exp, $sig] = array_pad(explode('.', $_COOKIE[COOKIE] ?? '', 2), 2, '');
  return ctype_digit($exp) && (int) $exp > time()
    && hash_equals(hash_hmac('sha256', $exp, $config['secret']), $sig);
}

function set_auth_cookie(array $config, bool $on): void {
  $exp = $on ? time() + SESSION_DAYS * 86400 : 1;
  $value = $on ? $exp . '.' . hash_hmac('sha256', (string) $exp, $config['secret']) : '';
  setcookie(COOKIE, $value, ['expires' => $exp, 'path' => '/', 'secure' => is_https(),
    'httponly' => true, 'samesite' => 'Strict']);
}

// --- Stockage ----------------------------------------------------------------------------

function now_ms(): int {
  return (int) floor(microtime(true) * 1000);
}

function write_atomic(string $file, string $data): void {
  $tmp = $file . '.tmp' . bin2hex(random_bytes(4));
  if (file_put_contents($tmp, $data) === false || !rename($tmp, $file)) {
    @unlink($tmp);
    reply(500, ['error' => 'write_failed']);
  }
}

function load_state(): array {
  $s = json_decode((string) @file_get_contents(DATA_DIR . '/state.json'), true);
  return (is_array($s) ? $s : []) + ['revision' => 0, 'lock' => null, 'docs' => [], 'purgedAt' => 0];
}

function save_state(array $s): void {
  write_atomic(DATA_DIR . '/state.json', json_encode($s, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
}

/** Nom de fichier lisible : « Mon Été ! » → « mon-ete ». */
function slug(string $title): string {
  $t = strtr($title, ['à' => 'a', 'â' => 'a', 'ä' => 'a', 'á' => 'a', 'ã' => 'a', 'å' => 'a',
    'ç' => 'c', 'é' => 'e', 'è' => 'e', 'ê' => 'e', 'ë' => 'e', 'î' => 'i', 'ï' => 'i', 'í' => 'i',
    'ì' => 'i', 'ô' => 'o', 'ö' => 'o', 'ó' => 'o', 'ò' => 'o', 'õ' => 'o', 'ù' => 'u', 'û' => 'u',
    'ü' => 'u', 'ú' => 'u', 'ÿ' => 'y', 'ñ' => 'n', 'œ' => 'oe', 'æ' => 'ae', 'À' => 'a', 'Â' => 'a',
    'Ä' => 'a', 'Ç' => 'c', 'É' => 'e', 'È' => 'e', 'Ê' => 'e', 'Ë' => 'e', 'Î' => 'i', 'Ï' => 'i',
    'Ô' => 'o', 'Ö' => 'o', 'Ù' => 'u', 'Û' => 'u', 'Ü' => 'u', 'Œ' => 'oe', 'Æ' => 'ae']);
  $t = trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($t)), '-');
  return trim(substr($t, 0, 60), '-') ?: 'sans-titre';
}

/** Premier nom libre : base.md, base-2.md, base-3.md… */
function unique_file(array $state, string $base): string {
  $used = array_column($state['docs'], 'file');
  for ($i = 1; ; $i++) {
    $name = $i === 1 ? "$base.md" : "$base-$i.md";
    if (!in_array($name, $used, true) && !file_exists(DATA_DIR . "/docs/$name")) return $name;
  }
}

function doc_payload(string $id, array $m): array {
  return ['id' => $id, 'title' => $m['title'], 'hasCustomTitle' => $m['hasCustomTitle'],
    'updatedAt' => $m['updatedAt'], 'content' => (string) @file_get_contents(DATA_DIR . '/docs/' . $m['file'])];
}

function purge_trash(array &$state): void {
  if (time() - $state['purgedAt'] < 3600) return;
  foreach (glob(DATA_DIR . '/trash/*.md') ?: [] as $f) {
    if (filemtime($f) < time() - TRASH_DAYS * 86400) @unlink($f);
  }
  $state['purgedAt'] = time();
}

// --- Requête -----------------------------------------------------------------------------

$action = $_GET['action'] ?? '';
$body = [];
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  // Anti-CSRF : en-tête personnalisé (impose un preflight cross-origin) + cookie SameSite=Strict.
  // « release » en est dispensé : il est envoyé par sendBeacon à la fermeture de l'onglet.
  if (($_SERVER['HTTP_X_WRITE0'] ?? '') !== '1' && $action !== 'release') reply(403, ['error' => 'csrf']);
  $raw = (string) file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
  if (strlen($raw) > MAX_BODY) reply(413, ['error' => 'too_large']);
  $body = json_decode($raw, true) ?? [];
} elseif ($action !== 'status') {
  reply(405, ['error' => 'post_only']);
}

if ($action === 'status') reply(200, ['authenticated' => authenticated($config)]);

if ($action === 'login') {
  $failFile = DATA_DIR . '/login-fails.json';
  $fails = json_decode((string) @file_get_contents($failFile), true) ?: ['count' => 0, 'since' => time()];
  if (time() - $fails['since'] > 900) $fails = ['count' => 0, 'since' => time()];
  if ($fails['count'] >= 5) reply(429, ['error' => 'too_many_attempts']);
  if (!password_verify((string) ($body['password'] ?? ''), $config['password_hash'])) {
    $fails['count']++;
    file_put_contents($failFile, json_encode($fails));
    sleep(1);
    reply(401, ['error' => 'bad_password']);
  }
  @unlink($failFile);
  set_auth_cookie($config, true);
  reply(200, ['authenticated' => true]);
}

if ($action === 'logout') {
  set_auth_cookie($config, false);
  reply(200, ['authenticated' => false]);
}

if (!authenticated($config)) reply(401, ['error' => 'unauthorized']);

$session = (string) ($body['session'] ?? '');
if (!preg_match('/^[A-Za-z0-9-]{8,64}$/', $session)) reply(400, ['error' => 'bad_session']);

@mkdir(DATA_DIR . '/docs', 0700, true);
@mkdir(DATA_DIR . '/trash', 0700, true);
$lockHandle = fopen(DATA_DIR . '/.lock', 'c');
flock($lockHandle, LOCK_EX); // une requête à la fois : lecture-modification-écriture sûre
$state = load_state();
$now = now_ms();
$lock = $state['lock'];
$ownerAlive = $lock && $now - $lock['beat'] <= OWNER_TIMEOUT_MS;
$isOwner = $lock && $lock['session'] === $session;

function require_owner(bool $isOwner): void {
  if (!$isOwner) reply(409, ['error' => 'not_owner']);
}

if ($action === 'poll') {
  // Battement de cœur de la session active, et suivi du texte pour les sessions passives.
  if ($isOwner) {
    $state['lock']['beat'] = $now;
    $state['lock']['doc'] = (string) ($body['activeDoc'] ?? '');
    save_state($state);
  }
  $since = (int) ($body['since'] ?? 0);
  if ($since > $state['revision']) $since = 0; // données serveur réinitialisées : tout renvoyer
  $changed = [];
  foreach ($state['docs'] as $id => $m) {
    if ($m['rev'] > $since) $changed[] = doc_payload((string) $id, $m);
  }
  reply(200, [
    'revision' => $state['revision'],
    'ids' => array_map('strval', array_keys($state['docs'])),
    'changed' => $changed,
    'owner' => $ownerAlive ? $lock['session'] : null,
    'ownerDoc' => $ownerAlive ? ($lock['doc'] ?? '') : '',
    'takeover' => $isOwner && !empty($lock['takeover']),
  ]);
}

if ($action === 'acquire') {
  $t = $lock['takeover'] ?? null;
  $waited = $t && $t['session'] === $session && $now - $t['at'] >= TAKEOVER_WAIT_MS;
  if (!$lock || $isOwner || !$ownerAlive || $waited) {
    $state['lock'] = ['session' => $session, 'beat' => $now, 'takeover' => null,
      'doc' => (string) ($body['activeDoc'] ?? '')];
    purge_trash($state);
    save_state($state);
    reply(200, ['granted' => true, 'revision' => $state['revision']]);
  }
  if (!$t || $t['session'] !== $session) {
    $state['lock']['takeover'] = ['session' => $session, 'at' => $now];
    save_state($state);
  }
  reply(200, ['granted' => false]);
}

if ($action === 'release') {
  if ($isOwner) {
    $state['lock'] = null;
    save_state($state);
  }
  reply(200, ['released' => $isOwner]);
}

if ($action === 'save') {
  require_owner($isOwner);
  $d = $body['doc'] ?? null;
  if (!is_array($d) || !is_string($d['content'] ?? null)
    || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', (string) ($d['id'] ?? ''))) reply(400, ['error' => 'bad_doc']);
  $id = $d['id'];
  $title = preg_match('/^.{0,200}/su', (string) ($d['title'] ?? ''), $t) ? $t[0] : '';
  $custom = !empty($d['hasCustomTitle']);
  $m = $state['docs'][$id] ?? ['file' => unique_file($state, 'brouillon-' . substr($id, 0, 8)), 'named' => false];
  // Le nom lisible est figé dès que le titre est connu (première ligne terminée, ou titre choisi).
  if (!$m['named'] && (str_contains($d['content'], "\n") || $custom)) {
    $file = unique_file($state, slug($title));
    if (file_exists(DATA_DIR . '/docs/' . $m['file'])) rename(DATA_DIR . '/docs/' . $m['file'], DATA_DIR . "/docs/$file");
    $m['file'] = $file;
    $m['named'] = true;
  }
  write_atomic(DATA_DIR . '/docs/' . $m['file'], $d['content']);
  $state['revision']++;
  $state['docs'][$id] = ['file' => $m['file'], 'named' => $m['named'], 'title' => $title,
    'hasCustomTitle' => $custom, 'updatedAt' => (int) ($d['updatedAt'] ?? $now), 'rev' => $state['revision']];
  $state['lock']['beat'] = $now;
  save_state($state);
  reply(200, ['revision' => $state['revision']]);
}

if ($action === 'delete') {
  require_owner($isOwner);
  $id = (string) ($body['id'] ?? '');
  $m = $state['docs'][$id] ?? null;
  if ($m) {
    $src = DATA_DIR . '/docs/' . $m['file'];
    if (is_file($src)) {
      $dest = DATA_DIR . '/trash/' . basename($m['file'], '.md') . '--' . date('Y-m-d_His') . '.md';
      rename($src, $dest);
      touch($dest); // la purge compte à partir de la suppression
    }
    unset($state['docs'][$id]);
    $state['revision']++;
  }
  purge_trash($state);
  save_state($state);
  reply(200, ['revision' => $state['revision']]);
}

reply(404, ['error' => 'unknown_action']);
