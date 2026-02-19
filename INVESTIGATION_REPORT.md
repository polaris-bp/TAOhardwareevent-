# TAO CBT システム - 矢印キー ハードウェアキーイベント問題 調査報告書

## 概要

TAO (Testing Assisté par Ordinateur) CBTシステムの受験画面（テストランナー）において、ハードウェアキーボードの上下左右矢印キーが期待通りに動作しない問題について調査を実施した。特に**自社IMEのPCI（Portable Custom Interaction）内でのカーソル操作**が妨害される問題の真の原因を特定した。

## 調査対象ソースコード

| リポジトリ | ファイル | 役割 |
|---|---|---|
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/plugin.js` | キーナビゲーションプラグイン本体 |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/keyNavigation.js` | キーナビゲーション制御ロジック |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/modes/defaultMode.js` | デフォルトモードキー設定 |
| `tao-test-runner-qti-fe` | `src/plugins/navigation/next.js` | 次問題ナビゲーション（allowShortcutsチェック参照用） |
| `tao-core-ui-fe` | `src/keyNavigation/navigableDomElement.js` | DOM要素レベルのキーイベント処理 |
| `tao-core-sdk-fe` | `src/util/shortcut/registry.js` | ショートカットキー登録・検出基盤 |
| `extension-tao-testqti` | `config/default/testRunner.conf.php` | テストランナー設定 |

---

## 真の原因（IME × PCI カーソル操作の問題）

### 原因1（最重要）: ショートカットレジストリが IME コンポジション状態を一切考慮していない

`tao-core-sdk-fe/src/util/shortcut/registry.js` の `onKeyboard` 関数：

```javascript
function onKeyboard(event) {
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

**`event.isComposing` のチェックが存在しない。** `compositionstart` / `compositionend` イベントの追跡も、`keyCode === 229` の判定も一切行われていない。

[MDN の公式推奨パターン](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event)では、IMEコンポジション中のイベントを無視するために以下のチェックが必須とされている：

```javascript
// MDN推奨: IMEコンポジション中のイベントを無視
eventTarget.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) {
        return;  // IME処理中は何もしない
    }
    // 通常のキー処理
});
```

**このチェックが `registry.js` に完全に欠落している。**

#### IME コンポジション中の矢印キーで何が起こるか

```
IMEコンポジション中にユーザーが矢印キーを押す
        │
        ▼
ブラウザが keydown イベントを発火
        │
        ├─ ケースA: ブラウザが keyCode=229 を設定する場合
        │   └─ getActualKey() → specialKeys[229] = undefined
        │     └─ event.key = 'Process' → key = 'process'
        │       └─ 'process' にマッチするショートカットなし → スルー
        │         └─ IMEのカーソル移動が動作する ✓
        │
        └─ ケースB: ブラウザが実際の keyCode(37-40) を設定する場合
            └─ getActualKey() → specialKeys[37] = 'left' 等
              └─ ショートカットにマッチ
                └─ event.stopPropagation() が呼ばれる
                  └─ event.preventDefault() が呼ばれる可能性
                    └─ ★ IMEのカーソル移動がブロックされる ✗
```

**ケースBが発生するかどうかはブラウザ・OS・IMEの組み合わせに依存する。**

[Mozilla Bug #1529467](https://bugzilla.mozilla.org/show_bug.cgi?id=1529467) によると、矢印キーのIMEコンポジション中の `keyCode` 挙動はブラウザ間で一貫していない：

- **Chrome**: compositionend 後に疑似的な keydown を発火する独自挙動あり
- **Firefox**: Chrome との互換性のためこの挙動に追従
- **一部のIME/OS組合せ**: 矢印キーで実際の keyCode (37-40) が設定されるケースが存在

これにより、**特定のブラウザ・OS・IMEの組み合わせでのみ問題が発生し、再現条件が不安定になる。**

---

### 原因2（直接原因）: `navigableDomElement.js` の `isInput()` が PCI のカスタム要素を認識しない

```javascript
const isInput = $el => $el.is(':text,textarea');
```

**この判定でカバーされる要素:**
- `<input type="text">`
- `<textarea>`

**この判定でカバーされない要素:**
- `<div contenteditable="true">` ← **PCI で多用される**
- `<input type="number">`, `<input type="search">`, `<input type="email">`
- カスタム Web Components
- `<canvas>` ベースのカスタム入力
- `<span>` や `<div>` にカスタムキーハンドラを持つ要素（MathQuill等）

PCI (Portable Custom Interaction) は任意のHTML5マークアップを内部に持てる。IMS PCI仕様では、`pci:markup` 要素の内容がDOMにコピーされ、PCI の `initialize(id, dom, config)` メソッドにルート要素が渡される。

**典型的なPCIのDOM構造例（Math Entry PCI）:**

```html
<!-- PCIコンテナ（TAOが管理） -->
<div class="qti-customInteraction">
    <!-- PCI内部マークアップ（任意のHTML5） -->
    <div class="math-entry-container">
        <span class="mq-root-block" contenteditable="true">...</span>  ← isInput()でfalse
    </div>
</div>
```

この場合：
1. ユーザーがPCI内のカスタム入力要素にフォーカス
2. IMEを起動して日本語入力中に矢印キーを押す
3. `navigableDomElement.js` のハンドラが発火
4. `isInput($target)` → `false`（contenteditable は `:text,textarea` に該当しない）
5. `e.preventDefault()` が呼ばれる → **IMEカーソル移動がブロック**
6. `keyboard(key, e.target)` が呼ばれる → **keyNavigationのUI間移動が実行される**

---

### 原因3: `stopPropagation()` がハンドラ実行前に呼ばれる

`registry.js` の `processShortcut` 関数：

```javascript
function processShortcut(event, descriptor) {
    const command = normalizeCommand(descriptor);
    const shortcut = shortcuts[command];
    if (shortcut && !states.disabled) {
        // avoidInput チェック（[type="text"],textarea のみ）
        if (shortcut.options.propagate === false) {
            event.stopPropagation();      // ← ハンドラ実行前に呼ばれる
        }
        if (shortcut.options.prevent === true) {
            event.preventDefault();       // ← ハンドラ実行前に呼ばれる
        }
        // ここでハンドラが実行される
        _.forEach(shortcutHandlers, function (handler) {
            handler(event, command);
        });
    }
}
```

`navigableDomElement.js` で矢印キーは `{ propagate: false }` で登録されている。

**重要:** `stopPropagation()` は `processShortcut` のオプション処理段階で呼ばれ、ハンドラ内の `isInput()` チェックより**先**に実行される。つまり：

```
keydown イベント発生
  → processShortcut() 呼び出し
    → event.stopPropagation()      ← ここで伝播が止まる（isInput判定の前）
      → handler() 実行
        → isInput() が true でも、stopPropagation は既に呼ばれた後
```

仮に `isInput()` が `true` を返してハンドラ内の処理がスキップされたとしても、**`stopPropagation()` は既に実行済み**であり、イベントは親要素に伝播しない。PCIがイベントデリゲーション（親要素でのイベント監視）を使用している場合、イベントが届かなくなる。

---

### 原因4: `keyNavigation` プラグインが `allow-shortcuts` 設定を無視

ナビゲーション・ツール系プラグインは `allowShortcuts` をチェックする：

```javascript
// next.js - チェックあり
if (testRunnerOptions.allowShortcuts && kbdShortcut) {
    shortcut.add(/* ... */);
}
```

`keyNavigation` プラグインはチェックしない：

```javascript
// plugin.js - チェックなし
testRunner.after('renderitem', () => {
    keyNavigator.init();  // ← 常に初期化
});

// keyNavigation.js - チェックなし
shortcut.add(`tab shift+tab`, function (e) { /* ... */ });  // ← 常に登録
```

| 設定 | J/K/C等 | keyNavigation Tab | keyNavigation 矢印キー |
|---|---|---|---|
| `allow-shortcuts: true` | 有効 | 有効 | 有効（インターセプト） |
| `allow-shortcuts: false` | **無効** | **依然有効** | **依然有効（インターセプト）** |

**`allow-shortcuts: false` にしても矢印キー問題は解決しない。**

---

### 原因5: `avoidInput` オプションの判定範囲が狭い

グローバルショートカット（Tab等）が使用する `avoidInput` 判定：

```javascript
if (shortcut.options.avoidInput === true) {
    const $target = $(event.target);
    if ($target.closest('[type="text"],textarea').length) {
        // input/textarea 内ではショートカットを無視
        return;
    }
}
```

この判定も `[type="text"],textarea` のみで、`contenteditable` やカスタムPCI要素はカバーされない。

---

## IME × PCI で問題が起こるメカニズム（全体像）

```
受験者がPCI内のカスタム入力要素（contenteditable等）でIMEを使用中
        │
        ▼
矢印キーを押してIME内のカーソルを移動しようとする
        │
        ▼
ブラウザが keydown イベントを発火
        │
        ├─ registry.js: onKeyboard(event)
        │   ├─ event.isComposing チェックなし ← 欠陥①
        │   └─ getActualKey() → 'left'/'right'/'up'/'down'
        │
        ▼
navigableDomElement の shortcutRegistry にマッチ
        │
        ├─ processShortcut():
        │   ├─ event.stopPropagation()  ← ハンドラ前に実行（欠陥③）
        │   └─ handler 呼び出し:
        │       ├─ isInput($target) → false  ← contenteditable未対応（欠陥②）
        │       ├─ e.preventDefault()        ← ネイティブ動作ブロック
        │       └─ keyboard(key, target)     ← keyNavigation内部ナビゲーション実行
        │
        ▼
結果: IMEカーソル移動が完全にブロックされ、
      代わりにテストランナーのUI間ナビゲーションが発生する
```

---

## 顧客との妥協案

### 妥協案1（推奨・最小リスク）: `registry.js` に IME コンポジションガードを追加

**変更箇所:** `tao-core-sdk-fe/src/util/shortcut/registry.js` の `onKeyboard` 関数

```javascript
function onKeyboard(event) {
    // IMEコンポジション中はショートカット処理をスキップ
    if (event.isComposing || event.keyCode === 229) {
        return;
    }
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

**メリット:**
- MDN公式推奨パターンに準拠
- 変更は1ファイル・2行のみ
- keyNavigation のアクセシビリティ機能はIME非使用時にそのまま維持
- 全てのショートカット（グローバル・要素レベル共に）で一括対応
- IME使用時のみ動作が変わるため、既存テストへの影響が最小

**デメリット:**
- IMEコンポジション中はTab/Shift+TabによるkeyNavigation操作も無効になる
- ブラウザ間の `isComposing` 挙動差異により、一部環境で効果がない可能性

**顧客への説明:**
> IMEでの日本語入力中は、TAOの矢印キーナビゲーション機能を一時的に無効化します。日本語入力確定後は通常通りナビゲーション機能が使えます。

---

### 妥協案2: `isInput()` の判定範囲を PCI 要素まで拡大

**変更箇所:** `tao-core-ui-fe/src/keyNavigation/navigableDomElement.js`

```javascript
// 変更前
const isInput = $el => $el.is(':text,textarea');

// 変更後
const isInput = $el =>
    $el.is(':text,textarea,select,[contenteditable="true"]') ||
    $el.closest('.qti-customInteraction').length > 0;
```

**メリット:**
- PCI内の全要素で矢印キーのネイティブ動作が許可される
- contenteditable 要素も正しく処理される
- IME非使用時でもPCI内のカーソル操作が機能する

**デメリット:**
- PCI内でkeyNavigation のアクセシビリティ機能が無効になる
- `.qti-customInteraction` クラス名への依存

**顧客への説明:**
> カスタムインタラクション（PCI）の領域内では、矢印キーをPCI本来の操作（カーソル移動、候補選択等）に使用できるようにします。PCI外のテストランナーUIではTAOのキーボードナビゲーション機能がそのまま使えます。

---

### 妥協案3（最も安全）: 妥協案1 + 妥協案2 の組み合わせ

両方の修正を適用する。

**メリット:**
- IMEコンポジション中の問題を根本的に解決（妥協案1）
- IME非使用時でもPCI内のカーソル操作が正常動作（妥協案2）
- 防御が二重になり、ブラウザ間の挙動差異にも対応できる

**デメリット:**
- 変更箇所が2ファイルに跨る
- 両方のテストが必要

---

### 妥協案4: `keyNavigation` プラグインを PCI 使用テストで無効化

**変更箇所:** PHP設定のみ（コード変更なし）

```php
// testRunner.conf.php の plugins セクション
'keyNavigation' => [
    'active' => false,  // キーナビゲーションを無効化
]
```

または、アイテムカテゴリ `x-tao-option-noKeyNavigation` を PCI 使用アイテムに付与して、アイテム単位で無効化する（TAOがこのカテゴリをサポートしている場合）。

**メリット:**
- コード変更不要
- 即座に適用可能
- 影響範囲が明確

**デメリット:**
- アクセシビリティ機能（WCAG対応のキーボードナビゲーション）が完全に失われる
- 視覚障害等のある受験者への配慮が必要
- アイテム単位の制御ができない場合は全テストに影響

**顧客への説明:**
> PCI（カスタムインタラクション）を使用するテストでは、TAOのキーボードナビゲーション機能を無効にすることで矢印キーの競合を回避します。アクセシビリティ対応が必要な場合は妥協案1または妥協案3をご検討ください。

---

### 妥協案5: `stopPropagation` の実行タイミングを修正

**変更箇所:** `tao-core-sdk-fe/src/util/shortcut/registry.js` の `processShortcut`

```javascript
function processShortcut(event, descriptor) {
    const command = normalizeCommand(descriptor);
    const shortcut = shortcuts[command];
    if (shortcut && !states.disabled) {
        // avoidInput チェック
        if (shortcut.options.avoidInput === true) { /* ... */ }

        // ★ preventDefault/stopPropagation をハンドラの後に移動し、
        //    ハンドラの戻り値で制御可能にする
        const shortcutHandlers = getCommandHandlers(command);
        let handled = false;
        if (shortcutHandlers) {
            _.forEach(shortcutHandlers, function (handler) {
                const result = handler(event, command);
                if (result !== false) {
                    handled = true;
                }
            });
        }
        if (handled) {
            if (shortcut.options.propagate === false) {
                event.stopPropagation();
            }
            if (shortcut.options.prevent === true) {
                event.preventDefault();
            }
        }
    }
}
```

**メリット:**
- ハンドラが `false` を返した場合にイベントをスルーできる
- `isInput()` が `true` を返した場合に `stopPropagation` を回避できる

**デメリット:**
- `registry.js` の振る舞いが根本的に変わる
- 既存の全ショートカット利用箇所への影響テストが必要
- 回帰リスクが高い

---

## 推奨方針

| 優先度 | 修正 | 対象 | リスク | 効果 |
|---|---|---|---|---|
| ★★★ | **妥協案1: IMEコンポジションガード** | `registry.js` | 低 | IME問題を根本解決 |
| ★★☆ | **妥協案2: isInput拡大** | `navigableDomElement.js` | 中 | PCI内操作を全般改善 |
| ★★★ | **妥協案3: 1+2の組合せ** | 両方 | 中 | 最も包括的 |
| ★☆☆ | 妥協案4: プラグイン無効化 | PHP設定 | 低 | 即効性あり（暫定対応） |
| ☆☆☆ | 妥協案5: stopPropagationタイミング変更 | `registry.js` | 高 | 根本的だが回帰リスク大 |

**短期対応として妥協案4（プラグイン無効化）を実施し、中期的に妥協案3（IMEガード + isInput拡大）を実装する**ことを推奨する。

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
