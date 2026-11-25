<?php
// Crée (ou remplace) DATA_DIR/config.php : hash du mot de passe + secret de signature.
// Usage : php setup.php <dossier-de-données>   (le mot de passe est demandé, non affiché)
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$dir = $argv[1] ?? getenv('WRITE0_DATA_DIR');
if (!$dir) { fwrite(STDERR, "Usage : php setup.php <dossier-de-données>   (sur Infomaniak : ~/write0-data)\n"); exit(1); }
@mkdir($dir, 0700, true);
echo 'Mot de passe : ';
shell_exec('stty -echo 2>/dev/null');
$pw = rtrim((string) fgets(STDIN), "\r\n");
shell_exec('stty echo 2>/dev/null');
echo "\n";
if (strlen($pw) < 12) { fwrite(STDERR, "12 caractères minimum.\n"); exit(1); }
$config = ['password_hash' => password_hash($pw, PASSWORD_DEFAULT), 'secret' => bin2hex(random_bytes(32))];
file_put_contents("$dir/config.php", "<?php\nreturn " . var_export($config, true) . ";\n");
chmod("$dir/config.php", 0600);
if (!is_file("$dir/.htaccess")) file_put_contents("$dir/.htaccess", "Require all denied\n");
echo "Configuration écrite dans $dir/config.php (toutes les sessions existantes sont révoquées).\n";
