# TAO CBT システム - 矢印キー ハードウェアキーイベント問題 調査報告書

## 概要

TAO (Testing Assisté par Ordinateur) CBTシステムの受験画面（テストランナー）において、ハードウェアキーボードの上下左右矢印キーが期待通りに動作しない問題について調査を実施した。特に**自社IMEのPCI（Portable Custom Interaction）内でのカーソル操作**が妨害される問題の真の原因を特定した。

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

`getActualKey` 関数は `event.which || event.keyCode` を使ってキーコードを取得し、`specialKeys` マップを優先して参照する：

```javascript
function getActualKey(event) {
    const code = event.which || event.keyCode;
    const character = code >= 32 ? String.fromCharCode(code).toLowerCase() : '';
    let key = event.key && event.key.toLowerCase();
    // ... event.code によるキー名補正ロジック ...
    return specialKeys[code] || key || character;
}
```

この挙動により、IMEコンポジション中の矢印キーの処理が分岐する：

```
IMEコンポジション中にユーザーが矢印キーを押す
        │
        ▼
ブラウザが keydown イベントを発火
        │
        ├─ ケースA: ブラウザが keyCode=229 を設定する場合
        │   └─ getActualKey():
        │       code = 229
        │       specialKeys[229] = undefined（マップに存在しない）
        │       event.key = 'Process' → key = 'process'
        │       return: undefined || 'process' = 'process'
        │     └─ 'process' にマッチするショートカットなし → スルー
        │       └─ IMEのカーソル移動が動作する ✓
        │
        └─ ケースB: ブラウザが実際の keyCode(37-40) を設定する場合
            └─ getActualKey():
                code = 37
                specialKeys[37] = 'left'
                return: 'left'（specialKeysが最優先で返される）
              └─ ショートカット 'left' にマッチ
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

`tao-core-ui-fe/src/keyNavigation/navigableDomElement.js` の矢印キーハンドラ内：

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

`registry.js` の `processShortcut` 関数の実際のコード：

```javascript
function processShortcut(event, descriptor) {
    const command = normalizeCommand(descriptor);
    const shortcut = shortcuts[command];

    if (shortcut && !states.disabled) {
        // [1] avoidInput チェック（ここで return すれば以降は実行されない）
        if (shortcut.options.avoidInput === true) {
            const $target = $(event.target);
            if ($target.closest('[type="text"],textarea').length) {
                if (!shortcut.options.allowIn || !$target.closest(shortcut.options.allowIn).length) {
                    return;  // input/textarea 内ではショートカットを無視
                }
            }
        }
        // [2] stopPropagation（avoidInput を通過した場合、ハンドラ実行前に呼ばれる）
        if (shortcut.options.propagate === false) {
            event.stopPropagation();
        }
        // [3] preventDefault（同様にハンドラ実行前）
        if (shortcut.options.prevent === true) {
            event.preventDefault();
        }
        // [4] ハンドラの実行
        const shortcutHandlers = getCommandHandlers(command);
        if (shortcutHandlers) {
            _.forEach(shortcutHandlers, function (handler) {
                handler(event, command);
            });
        }
    }
}
```

矢印キーは `navigableDomElement.js` で `{ propagate: false }` で登録されている（`avoidInput` は設定されていない）。

**重要:** `stopPropagation()` は `processShortcut` の [2] の段階で呼ばれ、ハンドラ内の `isInput()` チェック [4] より**先**に実行される。つまり：

```
keydown イベント発生
  → processShortcut() 呼び出し
    → [1] avoidInput: 矢印キーには設定なし → スキップ
    → [2] event.stopPropagation()      ← ここで伝播が止まる（isInput判定の前）
    → [3] prevent: 矢印キーには設定なし → スキップ
    → [4] handler() 実行
        → isInput() が true でも、stopPropagation は既に呼ばれた後
```

仮に `isInput()` が `true` を返してハンドラ内の処理がスキップされたとしても、**`stopPropagation()` は既に実行済み**であり、イベントは親要素に伝播しない。PCIがイベントデリゲーション（親要素でのイベント監視）を使用している場合、イベントが届かなくなる。

---

### 原因4: `keyNavigation` プラグインが `allow-shortcuts` 設定を無視

ナビゲーション・ツール系プラグインは `allowShortcuts` をチェックしてからショートカットを登録する：

```javascript
// next.js - allowShortcuts チェックあり
const registerShortcut = kbdShortcut => {
    if (testRunnerOptions.allowShortcuts && kbdShortcut) {
        shortcut.add(
            namespaceHelper.namespaceAll(kbdShortcut, this.getName(), true),
            () => { /* ... */ },
            { avoidInput: true, prevent: true }
        );
    }
};
```

`keyNavigation` プラグインはショートカット登録時に `allowShortcuts` をチェックしない：

```javascript
// plugin.js - allowShortcuts チェックなし
testRunner
    .after('renderitem', () => {
        if (keyNavigator.isActive()) {
            keyNavigator.destroy();  // 重複防止のための破棄
        }
        keyNavigator.init();  // ← allowShortcuts に関係なく常に初期化
    })
    .on('unloaditem', () => {
        keyNavigator.destroy();
    });
```

```javascript
// keyNavigation.js - init() 内のグローバルショートカット登録
// allowShortcuts チェックなし、ただし allowedToNavigateFrom による実行時ガードはある
shortcut
    .remove(eventNS)
    .add(`tab${eventNS} shift+tab${eventNS}`, function (e) {
        if (!allowedToNavigateFrom(e.target)) {
            return false;  // no-key-navigation クラスがある要素からは無視
        }
        if (!groupNavigator.isFocused()) {
            groupNavigator.focus();
        }
    });
```

**注意:** `keyNavigation.js` はハンドラ内で `allowedToNavigateFrom()` をチェックしているが、これは `no-key-navigation` CSSクラスの有無を判定するものであり、`allow-shortcuts` 設定とは無関係。ショートカットの**登録自体**は常に行われる。

| 設定 | J/K/C等 | keyNavigation Tab | keyNavigation 矢印キー |
|---|---|---|---|
| `allow-shortcuts: true` | 有効 | 有効 | 有効（インターセプト） |
| `allow-shortcuts: false` | **無効** | **依然有効** | **依然有効（インターセプト）** |

**`allow-shortcuts: false` にしても矢印キー問題は解決しない。**

---

### 原因5: `avoidInput` オプションの判定範囲が狭い

`registry.js` の `processShortcut` 内で使用される `avoidInput` 判定：

```javascript
if (shortcut.options.avoidInput === true) {
    const $target = $(event.target);
    if ($target.closest('[type="text"],textarea').length) {
        // allowIn オプション: 特定CSSクラス内では avoidInput を無視する例外指定
        if (!shortcut.options.allowIn || !$target.closest(shortcut.options.allowIn).length) {
            return;  // input/textarea 内ではショートカットを無視
        }
    }
}
```

この判定も `[type="text"],textarea` のみで、`contenteditable` やカスタムPCI要素はカバーされない。

**ただし、矢印キーに対する直接的な影響はない:** `navigableDomElement.js` で矢印キーを登録する際に `avoidInput` オプションは設定されていないため、この判定は矢印キーのショートカット処理では実行されない。影響があるのは `avoidInput: true` で登録された他のショートカット（例: `next.js` の次問題ショートカット）に限定される。

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
        │   ├─ avoidInput: 矢印キーには未設定 → スキップ
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

## PCI 側での対策（TAOコア変更なし）

### 前提: イベント伝播の構造

`itemNavigation.js` はアイテム内の `.qti-interaction` 要素を検出し、内部の `:input` 要素や `.key-navigation-focusable` 要素を `navigableDomElement` でラップする。PCI（`.qti-customInteraction`）が標準の `:input` 要素を含んでいる場合や、`key-navigation-focusable` クラスを持つ場合に、`navigableDomElement` の `shortcutRegistry`（`addEventListener('keydown', ..., false)` でバブルフェーズに登録）がPCI内部のキーイベントをインターセプトする。

```
DOM ツリー（上が外側）:
┌──────────────────────────────────────────────────────┐
│ .qti-item  (テストランナー管理)                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ .qti-interaction.qti-customInteraction           │ │
│  │  ← navigableDomElement の shortcutRegistry が     │ │
│  │    この要素またはその子要素に keydown リスナーを登録 │ │
│  │  ┌──────────────────────────────────────────────┐│ │
│  │  │ PCI ルート要素 (pci:markup の root)           ││ │
│  │  │  ┌──────────────────────────────────────────┐││ │
│  │  │  │ カスタム入力要素                          │││ │
│  │  │  │ (contenteditable, canvas, etc.)          │││ │
│  │  │  │  ← ユーザーがここで矢印キーを押す         │││ │
│  │  │  └──────────────────────────────────────────┘││ │
│  │  └──────────────────────────────────────────────┘│ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘

keydown イベントの伝播:
  Capture:  window → .qti-item → .qti-interaction → PCI root → 入力要素
  Target:   入力要素
  Bubble:   入力要素 → PCI root → .qti-interaction(★ここでTAOが横取り) → .qti-item → window
```

TAO の `shortcutRegistry` は `addEventListener(eventName, listener, false)`（**bubble フェーズ**）でDOM要素に登録される。PCI ルート要素はその**内側**にあるため、**PCI 側でバブリングを止めれば TAO のハンドラに到達しない。**

---

### PCI対策A（推奨）: 自社IME と PCI の `stopPropagation` を組み合わせた実装

#### イベント処理の全体フロー

```
ハードウェアキーボードで矢印キーを押下
    │
    ▼
ブラウザが keydown を発火（target: IME入力要素）
    │
    ▼  Bubble フェーズ（内→外の順に発火）
    │
    ├─① IME入力要素のハンドラ（自社IME）
    │   └─ IMEコンポジション中ならカーソル移動を処理
    │      └─ event.preventDefault() でネイティブ動作を上書き
    │      （※ stopPropagation は呼ばなくてよい）
    │
    ├─② PCI root のハンドラ（ガード）
    │   └─ event.stopPropagation() で TAO への伝播を遮断
    │
    ╳── ここで伝播が止まる ──╳
    │
    ├─③ TAO の shortcutRegistry ハンドラ
    │   └─ ★ 到達しない
    :
```

**ポイント:** `stopPropagation()` は上位要素への伝播を止めるが、**同一要素・子要素のリスナーには影響しない**。そのため IME ハンドラ（①）と PCI ガード（②）を別の階層に配置すれば、互いに干渉せず共存できる。

#### 実装コード

```javascript
// =============================================================
// PCI の initialize() メソッド
// =============================================================
initialize(id, dom, config, state) {

    // --- IME入力要素の作成 ---
    const imeInput = document.createElement('div');
    imeInput.setAttribute('contenteditable', 'true');
    imeInput.className = 'my-ime-input';
    dom.appendChild(imeInput);

    // ---------------------------------------------------------
    // ① 自社IME のキーハンドラ（入力要素に登録）
    //    IMEが矢印キーイベントを消化する
    // ---------------------------------------------------------
    let isComposing = false;

    imeInput.addEventListener('compositionstart', function() {
        isComposing = true;
    });
    imeInput.addEventListener('compositionend', function() {
        isComposing = false;
    });

    imeInput.addEventListener('keydown', function(event) {
        // IMEコンポジション中の矢印キー → IMEが消化
        if (isComposing || event.isComposing || event.keyCode === 229) {
            const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
            if (arrowKeys.includes(event.key)) {
                // IME独自のカーソル移動処理
                handleIMECursorMove(event.key);
                event.preventDefault();   // ネイティブ動作を上書き
                // ※ stopPropagation は不要（②で止める）
                return;
            }
        }
        // IME非コンポジション中の矢印キー → PCI内のカーソル移動
        // （必要に応じてここにも処理を追加可能）
    });

    // ---------------------------------------------------------
    // ② PCI root のガードハンドラ
    //    TAO の keyNavigation への伝播を遮断
    // ---------------------------------------------------------
    dom.addEventListener('keydown', function(event) {
        // IMEコンポジション中: 全キーイベントをTAOに渡さない
        if (event.isComposing || event.keyCode === 229) {
            event.stopPropagation();
            return;
        }
        // 矢印キー: PCI内の操作を優先（TAOに渡さない）
        const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
        if (arrowKeys.includes(event.key)) {
            event.stopPropagation();
            // ※ preventDefault() は呼ばない
            //    → IME非コンポジション時はネイティブカーソル移動を維持
        }
    }, false);

    // ... PCI本来の初期化処理 ...
}

function handleIMECursorMove(key) {
    // 自社IMEのカーソル移動ロジック
    switch (key) {
        case 'ArrowLeft':  /* 変換候補内で左移動 */ break;
        case 'ArrowRight': /* 変換候補内で右移動 */ break;
        case 'ArrowUp':    /* 候補リスト上移動 */   break;
        case 'ArrowDown':  /* 候補リスト下移動 */   break;
    }
}
```

#### なぜ ① と ② が干渉しないか

```
bubble フェーズの発火順:

  imeInput (①)  →  dom/PCI root (②)  →  TAO の shortcutRegistry (③)
     ↑                    ↑                      ↑
  IMEが処理         stopPropagation()         到達しない
  preventDefault()    ここで伝播停止
```

| 操作 | ①の動作 | ②の動作 | ③ TAO |
|---|---|---|---|
| IME中 + 矢印 | IMEがカーソル移動 + `preventDefault` | `stopPropagation` | 到達しない |
| IME中 + 矢印以外 | IMEが処理 | `stopPropagation` | 到達しない |
| IME外 + 矢印 | スルー | `stopPropagation` | 到達しない |
| IME外 + Tab等 | スルー | スルー | TAOが処理 ✓ |

**3つの防御層:**
1. **自社IME** (①): コンポジション中の矢印キーを消化し、独自カーソル移動を実行
2. **PCI ガード** (②): 矢印キー全般をTAOから隔離
3. **TAO** (③): Tab/Shift+Tab等、矢印キー以外は通常通り処理

#### `compositionstart`/`compositionend` の自前追跡が必要な理由

`event.isComposing` と `event.keyCode === 229` だけでは不十分なケースがある:

- **`compositionstart` の前の最初の `keydown`**: `isComposing` はまだ `false` だが `keyCode` は `229`
- **`compositionend` の後の最後の `keydown`**: Chrome は `compositionend` 後に疑似 `keydown` を発火し、`isComposing` が `false` になっている場合がある
- **自社IMEが独自のコンポジション管理をする場合**: ブラウザの `compositionstart`/`compositionend` とタイミングがずれる可能性

そのため、①で `compositionstart`/`compositionend` を**自前で追跡**(`isComposing` フラグ) しつつ、②では `event.isComposing || event.keyCode === 229` をフォールバックとして使用する二重ガードが安全。

**メリット:**
- TAO のコード変更が一切不要
- 自社IMEが矢印キーイベントを完全にコントロールできる
- IMEコンポジション中もIME外も、PCI内の矢印キーが正しく動作
- PCI 外の TAO キーボードナビゲーション機能には一切影響しない
- Tab/Shift+Tab はガードを通過するため、PCI↔テストランナーUI間の移動も維持

**デメリット:**
- PCI 内では TAO のキーボードナビゲーション（矢印キー）機能が無効になる
- PCI 開発者が個別に実装する必要がある

---

### PCI対策B: CSS クラス `no-key-navigation` の付与

```javascript
// PCI の initialize() メソッド内
initialize(id, dom, config, state) {
    dom.classList.add('no-key-navigation');
    // ... PCI本来の初期化処理 ...
}
```

TAO の `allowedToNavigateFrom()` 関数（`helpers.js`）は `no-key-navigation` クラスを持つ要素**およびその子孫要素**からのナビゲーションをブロックする：

```javascript
const ignoredClass = 'no-key-navigation';

export function allowedToNavigateFrom(from) {
    let element = from;
    // keyNavigator や navigable オブジェクトから DOM 要素を取得
    if (element && 'function' === typeof element.getCursor) {
        const {navigable} = element.getCursor();
        element = navigable;
    }
    if (element && 'function' === typeof element.getElement) {
        element = element.getElement();
    }
    const $element = $(element);

    // 要素自体、または祖先要素に no-key-navigation があればブロック
    if ($element.hasClass(ignoredClass) || $element.parents(`.${ignoredClass}`).length > 0) {
        return false;
    }
    return true;
}
```

**効果の範囲:**
- Tab/Shift+Tab によるグループ間移動 → **ブロックされる** (`keyNavigation.js` の Tab ハンドラ内の `allowedToNavigateFrom` チェック)
- 矢印キーによるアイテム間移動 → **ブロックされる** (`setupItemsNavigator` の `allowedToNavigateFrom` チェック)
- **ただし `stopPropagation()` と `preventDefault()` は依然として呼ばれる**

```
no-key-navigation が防ぐもの:
  ✓ keyNavigation のフォーカス移動アクション（this.next() / this.previous()）
  ✗ event.stopPropagation()  ← processShortcut()で先に実行される
  ✗ event.preventDefault()   ← navigableDomElement のハンドラで実行される
```

**結論: `no-key-navigation` だけでは不十分。** ナビゲーションアクション自体は止まるが、`stopPropagation()` と `preventDefault()` がハンドラ/オプション処理で先に実行されるため、ネイティブ動作（IMEカーソル移動）も同時にブロックされる。

---

### PCI対策C: CSS クラス `key-navigation-scrollable` の付与

```javascript
// PCI 内の入力要素に付与
inputElement.classList.add('key-navigation-scrollable');
```

`navigableDomElement.js` の矢印キーハンドラの該当部分：

```javascript
.add('up down left right', (e, key) => {
    const $target = $(e.target);
    if (!isInput($target)) {
        if (
            !$target.is('img') &&
            !$target.hasClass('key-navigation-scrollable') &&     // ← ここでチェック
            !($target.hasClass('key-navigation-scrollable-up') && (key === 'up' || key === 'left')) &&
            !($target.hasClass('key-navigation-scrollable-down') && (key === 'down' || key === 'right'))
        ) {
            e.preventDefault();  // scrollable クラスがあればスキップされる
        }
        keyboard(key, e.target);  // ← scrollable に関係なく常に実行される
    }
}, { propagate: false })
```

**効果の範囲:**
- `preventDefault()` → **回避される**（scrollable チェックで除外）
- `stopPropagation()` → **依然として呼ばれる**（`processShortcut` のオプション処理で実行済み）
- `keyboard(key, target)` → **依然として呼ばれる**（条件分岐の外にあるため、ナビゲーションが実行される）

**結論: `key-navigation-scrollable` だけでも不十分。** `preventDefault()` は回避できるが、`stopPropagation()` でイベント伝播が止まり、`keyboard()` でフォーカスが移動してしまう。

---

### PCI対策の比較

| 対策 | TAO変更 | preventDefault回避 | stopPropagation回避 | ナビゲーション停止 | IME対応 |
|---|---|---|---|---|---|
| **A: PCI内stopPropagation（推奨）** | 不要 | **✓** | **✓** | **✓** | **✓** |
| B: no-key-navigation | 不要 | ✗ | ✗ | ✓ | ✗ |
| C: key-navigation-scrollable | 不要 | ✓ | ✗ | ✗ | ✗ |
| B+C: 両方の組み合わせ | 不要 | ✓ | ✗ | ✓ | △ |

**PCI対策Aが唯一の完全な解決策。** イベントがTAOのハンドラに到達する前に止めるため、TAO側の全ての問題（`preventDefault`, `stopPropagation`, `keyboard()`, `isInput()` の狭い判定）を一括で回避できる。

---

## 顧客との妥協案（TAOコア変更を伴う案）

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
- `stopPropagation()` は `processShortcut` で `isInput()` チェック前に実行されるため、イベント伝播は依然として停止する（原因3参照）

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
- 妥協案2単体では `stopPropagation` 問題が残る（妥協案1と併用することで解消）

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
        // avoidInput チェック（変更なし）
        if (shortcut.options.avoidInput === true) {
            const $target = $(event.target);
            if ($target.closest('[type="text"],textarea').length) {
                if (!shortcut.options.allowIn || !$target.closest(shortcut.options.allowIn).length) {
                    return;
                }
            }
        }

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

### 推奨アプローチ

**即時対応:** PCI対策A（PCI内 `stopPropagation`）を自社PCI に実装する。TAO変更不要で即座に適用可能。

**TAO側の改善要望として:** 妥協案1（IMEコンポジションガード）を TAO 開発元に提案する。MDN公式推奨パターンであり、2行の変更で全PCI・全IMEに対して根本解決できる。

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
