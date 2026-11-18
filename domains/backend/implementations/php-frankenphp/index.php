<?php
// FrankenPHP worker mode, plain PHP + PDO (no framework).
ignore_user_abort(true);

$pdo = new PDO('pgsql:host=127.0.0.1;dbname=bench', 'bench', 'bench', [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_EMULATE_PREPARES => false,
]);
$one = $pdo->prepare('SELECT id, randomnumber FROM world WHERE id = ?');
$upd = $pdo->prepare('UPDATE world SET randomnumber = ? WHERE id = ?');
$list = $pdo->prepare('SELECT id, randomnumber FROM world WHERE id BETWEEN ? AND ? ORDER BY id');

$fetchOne = static function () use ($one): array {
    $one->execute([mt_rand(1, 10000)]);
    $r = $one->fetch(PDO::FETCH_NUM);
    return ['id' => $r[0], 'randomNumber' => $r[1]];
};

$handler = static function () use ($fetchOne, $upd, $list): void {
    header('Content-Type: application/json');
    $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $method = $_SERVER['REQUEST_METHOD'];
    if ($method === 'GET' && $path === '/json') {
        echo json_encode(['message' => 'Hello, World!']);
    } elseif ($method === 'GET' && $path === '/db') {
        echo json_encode($fetchOne());
    } elseif ($method === 'GET' && $path === '/queries') {
        $out = [];
        for ($i = 0; $i < 20; $i++) $out[] = $fetchOne();
        echo json_encode($out);
    } elseif ($method === 'GET' && $path === '/updates') {
        $out = [];
        for ($i = 0; $i < 5; $i++) {
            $w = $fetchOne();
            $w['randomNumber'] = mt_rand(1, 10000);
            $upd->execute([$w['randomNumber'], $w['id']]);
            $out[] = $w;
        }
        echo json_encode($out);
    } elseif ($method === 'GET' && $path === '/list') {
        $start = mt_rand(1, 9901);
        $list->execute([$start, $start + 99]);
        $out = [];
        foreach ($list->fetchAll(PDO::FETCH_NUM) as $r) {
            $out[] = ['id' => $r[0], 'randomNumber' => $r[1], 'isEven' => $r[1] % 2 === 0];
        }
        echo json_encode($out);
    } elseif ($method === 'POST' && $path === '/orders') {
        $o = json_decode(file_get_contents('php://input'), true);
        if (!is_array($o) || empty($o['items']) || !is_array($o['items'])) {
            http_response_code(400);
            return;
        }
        $qty = 0;
        $total = 0.0;
        foreach ($o['items'] as $it) {
            if (!is_int($it['quantity'] ?? null) || $it['quantity'] < 1 || !is_numeric($it['unitPrice'] ?? null)
                || $it['unitPrice'] < 0 || !is_string($it['sku'] ?? null) || $it['sku'] === '') {
                http_response_code(400);
                return;
            }
            $qty += $it['quantity'];
            $total += $it['quantity'] * $it['unitPrice'];
        }
        echo json_encode(['customerId' => $o['customerId'], 'itemCount' => count($o['items']),
            'totalQuantity' => $qty, 'total' => round($total * 100) / 100]);
    } else {
        http_response_code(404);
    }
};

while (frankenphp_handle_request($handler)) {
}
