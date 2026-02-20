# TAO CBT システム - 矢印キー ハードウェアキーイベント問題 調査報告書

## 概要

TAO (Testing Assisté par Ordinateur) CBTシステムの受験画面（テストランナー）において、ハードウェアキーボードの上下左右矢印キーが期待通りに動作しない問題について調査を実施した。特に**自社IMEのPCI（Portable Custom Interaction）内でのカーソル操作**が妨害される問題の真の原因を特定し、対策を決定した。

### 決定事項

**PCI ルート要素での矢印キー `stopPropagation` を採用する。**

PCI の `initialize()` メソッド冒頭で、矢印キーの keydown イベントが TAO 側へ伝播しないよう遮断する。

```javascript
dom.addEventListener('keydown', function(event) {
    var arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (arrowKeys.indexOf(event.key) !== -1) {
        event.stopPropagation();
    }
}, false);
```

- TAO のコード変更が不要
- PCI の `initialize()` に5行追加するだけで完結
- TAO 側の全ての欠陥（`preventDefault`、`stopPropagation`、ナビゲーション実行）を一括で回避
- `preventDefault()` を呼ばないため、PCI 内のネイティブ動作（カーソル移動等）は維持

---

## 調査対象ソースコード

| リポジトリ | ファイル | 役割 |
|---|---|---|
| `tao-core-sdk-fe` | `src/util/shortcut/registry.js` | ショートカットキー登録・検出基盤 |
| `tao-core-ui-fe` | `src/keyNavigation/navigableDomElement.js` | DOM要素レベルのキーイベント処理 |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/plugin.js` | キーナビゲーションプラグイン本体 |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/keyNavigation.js` | キーナビゲーション制御ロジック |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/helpers.js` | ナビゲーション判定ヘルパー |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/modes/defaultMode.js` | デフォルトモードキー設定 |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/strategies/itemNavigation.js` | アイテム内ナビゲーション戦略 |
| `tao-test-runner-qti-fe` | `src/plugins/navigation/next.js` | 次問題ナビゲーション（allowShortcutsチェック参照用） |
| `extension-tao-testqti` | `config/default/testRunner.conf.php` | テストランナー設定 |

---

## 真の原因

### 問題の全体像

PCI 内で矢印キーが効かない原因は、TAO の keydown イベント処理パイプラインにおける **3つの欠陥の連鎖** にある。

```
受験者が PCI 内で矢印キーを押す
    │
    ▼
registry.js: onKeyboard(event)
    │
    │  ★ 欠陥1: IME コンポジション中かどうかを判定しない
    │           → IME 操作中の矢印キーもショートカットとして処理してしまう
    │
    ▼
registry.js: processShortcut()
    │
    ├─ ★ 欠陥2: stopPropagation() をハンドラ実行前に呼ぶ
    │            → ハンドラ側で「処理不要」と判断しても、伝播は既に止まっている
    │
    ▼
navigableDomElement.js: 矢印キーハンドラ
    │
    ├─ ★ 欠陥3: isInput() が PCI のカスタム要素を認識しない
    │            → contenteditable 等が入力欄と判定されず、矢印キーを横取りする
    │
    ▼
結果: preventDefault() でネイティブ動作ブロック
      keyboard() で TAO のフォーカス移動が発生
      → IME カーソル移動が完全に妨害される
```

以下、各欠陥の詳細を説明する。

---

### 欠陥1: `registry.js` が IME コンポジション状態を無視する

**場所:** `tao-core-sdk-fe/src/util/shortcut/registry.js`

```javascript
function onKeyboard(event) {
    // ★ event.isComposing のチェックが存在しない
    processShortcut(event, {
        keyboardInvolved: true,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        key: getActualKey(event)
    });
}
```

[MDN の公式推奨パターン](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event)では、IME コンポジション中のイベントを無視するために `event.isComposing || event.keyCode === 229` のチェックが必須とされている。TAO にはこのチェックが完全に欠落している。

**ブラウザによる挙動の違い:**

IME コンポジション中に矢印キーを押した場合、ブラウザ・OS・IME の組み合わせにより `keyCode` の値が異なる。

| ケース | keyCode | getActualKey() の結果 | TAO の反応 |
|---|---|---|---|
| A: keyCode=229 | 229 | `'process'`（マッチなし） | スルー → IME 動作する |
| B: 実際のキーコード | 37〜40 | `'left'`/`'right'`/`'up'`/`'down'` | **マッチ → IME がブロックされる** |

ケース B の発生はブラウザ・OS・IME の組み合わせに依存するため、**再現条件が不安定になる根本原因**でもある（[Mozilla Bug #1529467](https://bugzilla.mozilla.org/show_bug.cgi?id=1529467) 参照）。

---

### 欠陥2: `stopPropagation()` がハンドラ実行前に呼ばれる

**場所:** `tao-core-sdk-fe/src/util/shortcut/registry.js` の `processShortcut`

```javascript
function processShortcut(event, descriptor) {
    const command = normalizeCommand(descriptor);
    const shortcut = shortcuts[command];

    if (shortcut && !states.disabled) {
        // [1] avoidInput チェック（矢印キーには未設定 → スキップ）
        if (shortcut.options.avoidInput === true) { /* ... */ }

        // [2] ★ ハンドラ実行前に stopPropagation
        if (shortcut.options.propagate === false) {
            event.stopPropagation();   // ← ここで伝播が止まる
        }
        // [3] preventDefault（矢印キーには未設定 → スキップ）
        if (shortcut.options.prevent === true) {
            event.preventDefault();
        }
        // [4] ハンドラの実行（この中で isInput() 判定が行われる）
        const shortcutHandlers = getCommandHandlers(command);
        if (shortcutHandlers) {
            _.forEach(shortcutHandlers, function (handler) {
                handler(event, command);
            });
        }
    }
}
```

矢印キーは `{ propagate: false }` で登録されている。`stopPropagation()` は [2] で実行されるが、ハンドラ内の `isInput()` チェックは [4] で行われる。**仮に `isInput()` が true を返してハンドラ内の処理がスキップされても、`stopPropagation()` は既に実行済み**であり、イベントは親要素に伝播しない。

---

### 欠陥3: `isInput()` が PCI のカスタム要素を認識しない

**場所:** `tao-core-ui-fe/src/keyNavigation/navigableDomElement.js`

```javascript
const isInput = $el => $el.is(':text,textarea');
```

この判定がカバーする要素は `<input type="text">` と `<textarea>` のみ。PCI で多用される以下の要素は**入力欄と認識されない:**

- `<div contenteditable="true">`（MathQuill 等）
- `<input type="number">`, `<input type="search">`, `<input type="email">`
- カスタム Web Components、`<canvas>` ベースの入力

結果として、矢印キーハンドラは PCI 内のカスタム入力要素に対して以下を実行する:

```javascript
.add('up down left right', (e, key) => {
    const $target = $(e.target);
    if (!isInput($target)) {           // ← PCI のカスタム要素は false
        if (/* scrollable チェック */) {
            e.preventDefault();        // ★ ネイティブ動作ブロック
        }
        keyboard(key, e.target);       // ★ TAO のフォーカス移動が実行される
    }
}, { propagate: false })
```

---

### 補足: TAO 側の設定による挙動

#### `allow-shortcuts: false` は矢印キーに効かない

ソースコードの追跡により、**`allow-shortcuts: false` は矢印キーのインターセプトを止めない**ことが確定した。

理由は2つある。

**理由1: `allow-shortcuts` は「登録しない」だけであり、registry の無効化ではない**

`allow-shortcuts: false`（JS 側では `allowShortcuts`）は、各プラグインの `init()` 内で `shortcut.add()` を呼ぶかどうかのガード条件として使われている:

```javascript
// next.js, previous.js, highlighter 等（グローバル registry を使うプラグイン）
if (testRunnerOptions.allowShortcuts && kbdShortcut) {
    shortcut.add(...);  // allowShortcuts=false なら add 自体をスキップ
}
```

`shortcut.disable()` を呼ぶコードは TAO の本番コードに**存在しない**（ユニットテストのみ）。

**理由2: 矢印キーはグローバル registry とは別の独立インスタンスに登録される**

TAO には2種類の shortcutRegistry が存在する:

```javascript
// ① グローバル singleton（window にバインド）
// util/shortcut.js
export default shortcutRegistry(window, defaultOptions);

// ② 要素ごとの独立インスタンス（各 DOM 要素にバインド）
// navigableDomElement.js
const shortcuts = shortcutRegistry($element);
```

| registry | バインド先 | 用途 | `allowShortcuts` の影響 |
|---|---|---|---|
| ① グローバル `util/shortcut` | `window` | J/K/C 等 | **あり**（add をスキップ） |
| ② 要素別 `shortcutRegistry($element)` | 各 DOM 要素 | **矢印キー・Tab・Enter** | **なし** |

矢印キーは ② の要素別インスタンスに登録されるため、`allowShortcuts` の設定に関わらず常にアクティブとなる。仮にグローバル registry が `disable()` されたとしても、② は完全に別のオブジェクトであり影響を受けない。

#### 「ショートカット設定オフで矢印キーが効いた」事象の解釈

CBT システム側で「ショートカット設定をオフ」にした際に矢印キーが正常動作した事象が確認されている。上記の分析により `allow-shortcuts: false` では説明できないため、**keyNavigation プラグイン自体の非活性化**が行われたと推定する:

```php
'keyNavigation' => ['active' => false]
```

プラグインがロードされなければ `navigableDomElement` も生成されず、矢印キーの shortcutRegistry 登録自体が行われない。

#### keyNavigation プラグイン無効化では不十分な理由

| 観点 | keyNavigation プラグイン無効化 | PCI 内 `stopPropagation` |
|---|---|---|
| TAO 側の設定変更 | **必要**（TAO 管理者依存） | 不要 |
| PCI 開発者が制御可能か | いいえ | **はい** |
| 影響範囲 | テスト全体のキーボードナビ喪失 | **矢印キーのみ、PCI 内のみ** |
| アクセシビリティ（WCAG） | 準拠不可 | PCI 外は維持 |
| 設定変更後の再設定リスク | TAO アップデート時に戻る可能性 | PCI コードに内包 |

#### `avoidInput` オプションが効かない理由

`avoidInput` は `processShortcut` 内で `[type="text"],textarea` のみを判定する。PCI のカスタム要素はカバーされない。加えて、**矢印キーのショートカットには `avoidInput` オプション自体が設定されていない**ため、この判定自体が実行されない。

---

## 採用対策の詳細

### 方針

PCI の `initialize()` メソッド冒頭で、PCI ルート要素（`dom`）に keydown リスナーを登録し、矢印キーイベントの上位への伝播を遮断する。TAO のハンドラはバブルフェーズ（`addEventListener(..., false)`）で PCI より外側の要素に登録されているため、PCI ルートで `stopPropagation()` を呼べば TAO のハンドラには到達しない。

### イベント伝播の構造

```
DOM ツリー（上が外側）:
┌──────────────────────────────────────────────────────┐
│ .qti-item  (テストランナー管理)                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ .qti-interaction.qti-customInteraction           │ │
│  │  ← TAO の shortcutRegistry がここに登録           │ │
│  │  ┌──────────────────────────────────────────────┐│ │
│  │  │ PCI ルート要素 (dom)                          ││ │
│  │  │  ← ★ ここで stopPropagation して遮断          ││ │
│  │  │  ┌──────────────────────────────────────────┐││ │
│  │  │  │ カスタム入力要素                          │││ │
│  │  │  │ (contenteditable, canvas, etc.)          │││ │
│  │  │  └──────────────────────────────────────────┘││ │
│  │  └──────────────────────────────────────────────┘│ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘

keydown バブリング:
  入力要素 → PCI root (★ここで遮断) ╳ → TAO shortcutRegistry → ...
```

### 実装コード

```javascript
initialize: function initialize(id, dom, config, state) {

    // 矢印キーの TAO への伝播を遮断
    dom.addEventListener('keydown', function(event) {
        var arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
        if (arrowKeys.indexOf(event.key) !== -1) {
            event.stopPropagation();
        }
    }, false);

    // ... PCI 本来の初期化処理 ...
}
```

**この5行だけで、TAO 側の3つの欠陥を全て回避できる。**

- `stopPropagation()` により、イベントが TAO の `shortcutRegistry` に到達しない
- TAO の `preventDefault()` も `keyboard()` も実行されない
- PCI 側では `preventDefault()` を呼んでいないため、ネイティブ動作は維持される

### なぜこれで十分か

```
バブルフェーズの発火順:

  PCI 内の入力要素  →  dom/PCI root  →  TAO shortcutRegistry
                           ↑                    ↑
                    stopPropagation()       到達しない
                     ここで伝播停止
```

| 状況 | PCI ガード | TAO |
|---|---|---|
| 矢印キー（IME 中・外を問わず） | `stopPropagation` で遮断 | 到達しない |
| Tab / Shift+Tab 等 | スルー | TAO が通常処理 |

矢印キーかどうかだけを判定し、IME の状態は判定しない。目的は「矢印キーを TAO に渡さない」ことであり、IME の状態に関わらず矢印キーは PCI 内に留めるべきだからである。

### 副作用の評価

#### 問題が起きないもの

| 操作 | 理由 |
|---|---|
| PCI 内の contenteditable カーソル移動 | `preventDefault()` を呼んでいないため、ネイティブ動作は維持 |
| PCI 内の `<select>`, `<input type="range">` 等 | 同上 |
| Tab / Shift+Tab によるフォーカス移動 | 遮断対象に含めていないため通過 |
| PCI **外** の TAO キーナビゲーション | `stopPropagation` は bubble 上方向のみ遮断。PCI 外には影響なし |
| IME 中に `event.key === 'Process'` のケース | 矢印キーチェックに該当しないが、TAO の `getActualKey()` も同様にマッチしないため問題なし |

#### 許容する副作用

| 副作用 | 影響度 | 対処 |
|---|---|---|
| PCI 内で TAO の矢印キーナビゲーションが無効になる | 低 | PCI が単一入力要素のみの場合は影響なし。複数要素がある場合は Tab キーで移動可能 |
| TAO が将来矢印キーに新機能を追加した場合、PCI 内では使えない | 低 | 現時点では矢印キーは keyNavigation のみ。将来リスクとして認識 |

---

## 不採用とした PCI 側対策（参考）

以下の対策も検討したが、いずれも3つの欠陥を完全には解決できないため不採用とした。

### PCI対策B: CSS クラス `no-key-navigation` の付与

```javascript
dom.classList.add('no-key-navigation');
```

TAO の `allowedToNavigateFrom()` がナビゲーションアクションをブロックするが、**`stopPropagation()` と `preventDefault()` は `processShortcut()` 内で先に実行されるため、ネイティブ動作は依然としてブロックされる。**

### PCI対策C: CSS クラス `key-navigation-scrollable` の付与

```javascript
inputElement.classList.add('key-navigation-scrollable');
```

`preventDefault()` は回避されるが、**`stopPropagation()` は依然として呼ばれ、`keyboard()` によるフォーカス移動も実行される。**

### 対策比較

| 対策 | TAO 変更 | preventDefault 回避 | stopPropagation 回避 | ナビゲーション停止 | IME 対応 |
|---|---|---|---|---|---|
| **PCI 内 stopPropagation（採用）** | 不要 | **✓** | **✓** | **✓** | **✓** |
| B: no-key-navigation | 不要 | ✗ | ✗ | ✓ | ✗ |
| C: key-navigation-scrollable | 不要 | ✓ | ✗ | ✗ | ✗ |
| B+C: 両方の組み合わせ | 不要 | ✓ | ✗ | ✓ | △ |

---

## TAO コア変更を伴う妥協案（参考）

TAO 開発元への改善要望として提案可能な案を以下にまとめる。自社 PCI では上記の採用対策で対応するが、TAO エコシステム全体の改善としてはこれらの変更が有効。

### 妥協案1: `registry.js` に IME コンポジションガードを追加

**変更箇所:** `tao-core-sdk-fe/src/util/shortcut/registry.js`

```javascript
function onKeyboard(event) {
    if (event.isComposing || event.keyCode === 229) {
        return;
    }
    processShortcut(event, { /* ... */ });
}
```

- MDN 公式推奨パターンに準拠、変更は2行のみ
- 全ショートカットで一括対応
- デメリット: IME コンポジション中は Tab/Shift+Tab も無効になる

### 妥協案2: `isInput()` の判定範囲を拡大

**変更箇所:** `tao-core-ui-fe/src/keyNavigation/navigableDomElement.js`

```javascript
// 変更前
const isInput = $el => $el.is(':text,textarea');

// 変更後
const isInput = $el =>
    $el.is(':text,textarea,select,[contenteditable="true"]') ||
    $el.closest('.qti-customInteraction').length > 0;
```

- PCI 内の全要素で矢印キーのネイティブ動作が許可される
- デメリット: `stopPropagation()` は欠陥2により依然として実行される

### 妥協案3: 妥協案1 + 妥協案2 の組み合わせ

両方を適用する最も包括的なアプローチ。変更箇所が2ファイルに跨る。

### 妥協案4: `keyNavigation` プラグインを無効化

```php
'keyNavigation' => ['active' => false]
```

コード変更不要で即効性があるが、アクセシビリティ機能（WCAG 対応）が完全に失われる。

### 妥協案5: `stopPropagation` の実行タイミングを修正

`processShortcut` でハンドラ実行後に `stopPropagation` を呼ぶよう変更。ハンドラの戻り値で制御可能にする。回帰リスクが高い。

### TAO 改善要望としての優先度

| 優先度 | 案 | リスク | 効果 |
|---|---|---|---|
| ★★★ | 妥協案1: IME コンポジションガード | 低 | IME 問題を根本解決 |
| ★★☆ | 妥協案2: isInput 拡大 | 中 | PCI 内操作を全般改善 |
| ★★★ | 妥協案3: 1+2 の組合せ | 中 | 最も包括的 |
| ★☆☆ | 妥協案4: プラグイン無効化 | 低 | 即効性あり（暫定対応） |
| ☆☆☆ | 妥協案5: stopPropagation タイミング変更 | 高 | 根本的だが回帰リスク大 |

---

## 参考リンク

- [MDN: Element keydown event - isComposing の推奨パターン](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event)
- [Mozilla Bug #1529467 - Arrow keys during Hangul composition](https://bugzilla.mozilla.org/show_bug.cgi?id=1529467)
- [Mozilla Bug #1343451 - keyCode 229 for IME events](https://bugzilla.mozilla.org/show_bug.cgi?id=1343451)
- [IMS PCI Specification](https://www.imsglobal.org/sites/default/files/assessment/pciv1p0/pciv1p0.html)
- [TAO PCI Developer Guide](https://github.com/oat-sa/taohub-articles/blob/master/forge/QTI/tao-pci.md)
- [TAO Test Runner Plugins Wiki](https://github.com/oat-sa/extension-tao-testqti/wiki/Test-Runner-Plugins)
- [TAO Test Runner Config Wiki](https://github.com/oat-sa/extension-tao-testqti/wiki/Test-Runner-Config)
- [tao-test-runner-qti-fe リポジトリ](https://github.com/oat-sa/tao-test-runner-qti-fe)
- [tao-core-ui-fe リポジトリ](https://github.com/oat-sa/tao-core-ui-fe)
- [tao-core-sdk-fe リポジトリ](https://github.com/oat-sa/tao-core-sdk-fe)
- [MDN: KeyboardEvent.keyCode (非推奨)](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/keyCode)
