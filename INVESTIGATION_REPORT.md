# TAO CBT システム - 矢印キー ハードウェアキーイベント問題 調査報告書

## 概要

TAO (Testing Assiste par Ordinateur) CBTシステムの受験画面（テストランナー）において、ハードウェアキーボードの上下左右矢印キーが期待通りに動作しない問題について調査を実施した。

## 調査対象ソースコード

以下のリポジトリ・ファイルを調査した：

| リポジトリ | ファイル | 役割 |
|---|---|---|
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/plugin.js` | キーナビゲーションプラグイン本体 |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/keyNavigation.js` | キーナビゲーション制御ロジック |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/helpers.js` | ナビゲーションヘルパー関数 |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/modes/defaultMode.js` | デフォルトモードキー設定 |
| `tao-core-ui-fe` | `src/keyNavigation/navigableDomElement.js` | DOM要素レベルのキーイベント処理 |
| `tao-core-ui-fe` | `src/keyNavigation/navigator.js` | キーナビゲーターファクトリ |
| `tao-core-sdk-fe` | `src/util/shortcut/registry.js` | ショートカットキー登録・検出基盤 |
| `extension-tao-testqti` | `config/default/testRunner.conf.php` | テストランナー設定 |

---

## 原因分析

### 原因1（主因）: `navigableDomElement.js` による矢印キーイベントの完全なインターセプト

`tao-core-ui-fe/src/keyNavigation/navigableDomElement.js` において、矢印キーは以下のように登録されている：

```javascript
.add(
    'up down left right',
    (e, key) => {
        const $target = $(e.target);
        if (!isInput($target)) {
            if (
                !$target.is('img') &&
                !$target.hasClass('key-navigation-scrollable') &&
                !(
                    $target.hasClass('key-navigation-scrollable-up') &&
                    (key === 'up' || key === 'left')
                ) &&
                !(
                    $target.hasClass('key-navigation-scrollable-down') &&
                    (key === 'down' || key === 'right')
                )
            ) {
                e.preventDefault();  // ← ネイティブ動作をブロック
            }
            keyboard(key, e.target);  // ← プラグイン内部ナビゲーションに転送
        }
    },
    { propagate: false }  // ← event.stopPropagation() が呼ばれる
)
```

**影響:**
- `event.preventDefault()`: ブラウザのネイティブ矢印キー動作（スクロール、ラジオボタン選択、ドロップダウン操作）が全て抑制される
- `propagate: false`: `event.stopPropagation()` により、イベントが親要素やwindowに伝播しない
- ハードウェアキーイベントはキーナビゲーションプラグインの内部ロジックに完全に消費される

**CSSクラスによる例外:**
- `key-navigation-scrollable`: 全方向のスクロールを許可
- `key-navigation-scrollable-up`: 上・左方向のみ許可
- `key-navigation-scrollable-down`: 下・右方向のみ許可

ただし、QTIアイテムコンテンツ（問題本文やインタラクション要素）にこれらのCSSクラスが付与されていない場合、矢印キーのネイティブ動作は全て抑制される。

---

### 原因2: 矢印キーがプラグインナビゲーションに割り当てられ、コンテンツ操作に使用できない

`defaultMode.js` の設定：

```javascript
config: Object.assign({
    keyNextGroup: 'tab',
    keyPrevGroup: 'shift+tab',
    keyNextItem: 'right down',   // ← 右・下矢印で「次のUIセクション」へ移動
    keyPrevItem: 'left up',      // ← 左・上矢印で「前のUIセクション」へ移動
    keyNextTab: 'right',
    keyPrevTab: 'left',
    keyNextContent: 'down',
    keyPrevContent: 'up'
}, config)
```

矢印キーはテストランナーのUIセクション間（ヘッダー、ツールバー、問題エリア、ナビゲーター等）の移動に使用されており、QTIアイテム内のコンテンツ操作（ラジオボタン選択、テキストスクロール等）には転送されない。

**具体的に影響を受ける操作:**
- 択一問題のラジオボタン間の移動（通常、上下キーで選択肢を切り替え）
- ドロップダウン（select要素）の選択肢の変更
- 長文のスクロール
- テキスト入力欄内のカーソル移動（※ `isInput()` チェックで除外されるため、入力欄は影響を受けない可能性あり）

---

### 原因3: フォーカス管理の問題

`keyNavigation.js` の `init()` メソッド：

```javascript
// blur current focused element, to reinitialize keyboard navigation
if (document.activeElement) {
    document.activeElement.blur();
}
```

アイテム描画後にフォーカスが強制的に外される。その後、ユーザーがTabキーでキーナビゲーターを有効化するまで、矢印キーイベントを処理するハンドラが存在しない状態になる。

**発生シナリオ:**
1. 新しい問題がレンダリングされる
2. `renderitem` イベントで `keyNavigator.init()` が呼ばれる
3. `document.activeElement.blur()` で現在のフォーカスが外れる
4. ユーザーがTabを押す前に矢印キーを押す → イベントは `document.body` に発火
5. `document.body` にはキーナビゲーションのハンドラが登録されていない
6. 矢印キーイベントは何も処理されない（ただしブラウザのデフォルト動作は発生する可能性あり）

---

### 原因4: ショートカットレジストリのキー検出が非推奨APIに依存

`tao-core-sdk-fe/src/util/shortcut/registry.js` の `getActualKey()` 関数：

```javascript
function getActualKey(event) {
    const code = event.which || event.keyCode;  // ← 非推奨API
    const character = code >= 32 ? String.fromCharCode(code).toLowerCase() : '';
    let key = event.key && event.key.toLowerCase();  // ← 標準API（フォールバック）
    // ...
    return specialKeys[code] || key || character;
}
```

- `event.which` と `event.keyCode` は[Web標準で非推奨](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/keyCode)
- 現在のブラウザではまだサポートされているが、将来的に削除される可能性がある
- 一部のハードウェアキーボード・入力メソッド・ブラウザの組み合わせで、これらのプロパティが正しく設定されないケースが報告されている
- 標準の `event.key` は二次的なフォールバックとしてのみ使用されている

**特殊キーのマッピング:**
```javascript
const specialKeys = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down',
    // ...
};
const translateKeys = {
    arrowdown: 'down', arrowleft: 'left',
    arrowright: 'right', arrowup: 'up'
};
```

`event.keyCode` が正しく 37-40 を返す場合は `specialKeys` で正しくマッピングされるが、`event.keyCode` が 0 や undefined を返す場合は `event.key`（'ArrowDown' → 'arrowdown' → 'down'）にフォールバックする。

---

### 原因5: ショートカットレジストリのイベントリスナー登録の潜在的問題

`registry.js` の `registerEvent` 関数：

```javascript
function registerEvent(target, eventName, listener) {
    if (target.addEventListener) {
        target.addEventListener(eventName, listener, false);
    } else if (target.attachEvent) {
        target.attachEvent(`on${eventName}`, listener);
    } else {
        target[`on${eventName}`] = listener;
    }
}
```

`navigableDomElement.js` では：
```javascript
const shortcuts = shortcutRegistry($element);  // $element は jQuery オブジェクト
```

`shortcutRegistry` に jQuery オブジェクトが渡された場合：
- jQuery オブジェクトは `addEventListener` メソッドを直接持たない
- jQuery オブジェクトは `attachEvent` メソッドも持たない
- フォールバックの `target['onkeydown'] = listener` が使用される可能性がある
- この場合、jQuery ラッパーのプロパティに設定されるだけで、実際のDOM要素にイベントリスナーが登録されない可能性がある

ただし、TAOの内部実装で jQuery オブジェクトからDOM要素を抽出する処理がある場合、この問題は発生しない。

---

## テストランナーのショートカット設定

`testRunner.conf.php` のデフォルト設定：

| 機能 | ショートカット |
|---|---|
| キーナビゲーション - 次 | `Tab` |
| キーナビゲーション - 前 | `Shift+Tab` |
| 次の問題 | `J` (アクセシビリティ: `Alt+Shift+N`) |
| 前の問題 | `K` (アクセシビリティ: `Alt+Shift+P`) |
| 電卓 | `C` |
| ズームイン | `I` |
| ズームアウト | `O` |
| レビューパネル | `R` |
| フラグ | `M` |

**注目点:** グローバルショートカット設定に矢印キーは含まれていない。矢印キーは `keyNavigation` プラグイン内部でのみ使用されている。

---

## 重要な追加調査: `allow-shortcuts: false` 設定との関係

### 調査結果: ショートカット無効化は矢印キー問題を解決しない

`testRunner.conf.php` の `allow-shortcuts` 設定と `keyNavigation` プラグインの関係を詳細に調査した結果、**ショートカットを無効化しても矢印キーの問題は発生し続ける**ことが判明した。

#### 根拠: `allowShortcuts` チェックの有無の比較

**ナビゲーション・ツール系プラグイン（チェックあり）:**

`next.js`, `previous.js`, `calculator.js` 等のプラグインは、ショートカット登録前に `allowShortcuts` を必ずチェックしている：

```javascript
// next.js - ショートカット登録前に allowShortcuts をチェック
const registerShortcut = kbdShortcut => {
    if (testRunnerOptions.allowShortcuts && kbdShortcut) {   // ← チェックあり
        shortcut.add(
            namespaceHelper.namespaceAll(kbdShortcut, this.getName(), true),
            () => {
                if (this.getState('enabled') === true) {
                    testRunner.trigger('nav-next', true);
                }
            },
            { avoidInput: true, prevent: true }
        );
    }
};
```

`allow-shortcuts: false` の場合、`J`, `K`, `C`, `I`, `O` 等のグローバルショートカットは登録されない。

**keyNavigation プラグイン（チェックなし）:**

```javascript
// plugin.js - allowShortcuts チェックが一切ない
export default pluginFactory({
    name: 'keyNavigation',
    init() {
        const testRunner = this.getTestRunner();
        const pluginConfig = _.defaults(this.getConfig(), defaultPluginConfig);
        const keyNavigator = keyNavigatorFactory(testRunner, pluginConfig);

        testRunner
            .after('renderitem', () => {
                if (keyNavigator.isActive()) {
                    keyNavigator.destroy();
                }
                keyNavigator.init();   // ← 常に初期化される
            })
            // ...
    }
});
```

```javascript
// keyNavigation.js - allowShortcuts チェックなしでショートカット登録
shortcut
    .remove(eventNS)
    .add(`tab${eventNS} shift+tab${eventNS}`, function (e) {   // ← 常に登録
        if (!allowedToNavigateFrom(e.target)) {
            return false;
        }
        if (!groupNavigator.isFocused()) {
            groupNavigator.focus();
        }
    });
```

#### 影響の整理

| 設定 | ナビゲーション/ツール系<br>(J, K, C等) | keyNavigation Tab/Shift+Tab | keyNavigation 矢印キー |
|---|---|---|---|
| `allow-shortcuts: true` | 有効 | 有効 | 有効（インターセプトあり） |
| `allow-shortcuts: false` | **無効** | **依然として有効** | **依然として有効（インターセプトあり）** |

#### なぜこうなっているか

- `keyNavigation` プラグインは `content` カテゴリのアクセシビリティプラグインとして設計されている
- ショートカット系プラグイン（`navigation`, `tools` カテゴリ）とは独立した設計
- `allow-shortcuts` 設定は `navigation`/`tools` 系プラグインのみが参照しており、`content` 系プラグインには適用されない
- `keyNavigation` が使用するグローバルショートカット（Tab/Shift+Tab）は `shortcut.add()` を直接呼び出しており、`allowShortcuts` フラグを経由しない
- `navigableDomElement` の矢印キーハンドラは要素レベルの独自 `shortcutRegistry` インスタンスで動作し、グローバルの `allow-shortcuts` 設定とは完全に独立

#### 結論

**`allow-shortcuts: false` に設定しても、`keyNavigation` プラグインは影響を受けず、矢印キーのインターセプトは継続する。** これは設計上の問題であり、`keyNavigation` プラグインが `allowShortcuts` 設定を無視していることが根本的な原因の一つである。

---

## 総合結論

矢印キーのハードウェアキーイベントが効かない主な原因は以下の通り：

1. **`navigableDomElement.js` が矢印キーイベントを完全にインターセプトし、`preventDefault()` と `stopPropagation()` で消費している** — これが最も直接的な原因
2. **矢印キーがプラグインのUI間ナビゲーションに使用され、QTIアイテム内のコンテンツ操作に転送されない** — ユーザーが期待する動作（ラジオボタン選択等）ができない
3. **フォーカス管理の問題により、Tabキーでナビゲーターを有効化するまで矢印キーが機能しない状態が発生する** — 特にアイテム切り替え直後
4. **`keyNavigation` プラグインが `allow-shortcuts` 設定を無視している** — ショートカット無効化でも矢印キーのインターセプトが継続する

---

## 推奨される修正方法

### 修正案A: QTIインタラクション要素への矢印キーイベントのパススルー

`navigableDomElement.js` の矢印キーハンドラに、QTIインタラクション要素（ラジオボタン、チェックボックス、select要素等）に対するパススルーロジックを追加する。

```javascript
// 修正例: QTIインタラクション要素では矢印キーのネイティブ動作を許可
if (!isInput($target) && !isQtiInteraction($target)) {
    // 既存のkeyNavigationロジック
}
```

### 修正案B: `key-navigation-scrollable` CSSクラスの適用範囲拡大

QTIアイテムのコンテンツ領域に `key-navigation-scrollable` クラスを付与し、矢印キーのネイティブ動作を許可する。

### 修正案C: キーマッピングの変更

`defaultMode.js` の設定で、矢印キーをプラグインナビゲーションから外し、QTIコンテンツ操作に使えるようにする。例：`keyNextItem`/`keyPrevItem` を `Tab`/`Shift+Tab` のみに変更。

### 修正案D: `keyNavigation` プラグインに `allowShortcuts` チェックを追加

`plugin.js` で `allowShortcuts` 設定を参照し、ショートカットが無効の場合はプラグインを初期化しないようにする。

```javascript
// 修正例: plugin.js
init() {
    const testRunner = this.getTestRunner();
    const testRunnerOptions = testRunner.getOptions();
    const pluginConfig = _.defaults(this.getConfig(), defaultPluginConfig);
    const keyNavigator = keyNavigatorFactory(testRunner, pluginConfig);

    testRunner
        .after('renderitem', () => {
            if (!testRunnerOptions.allowShortcuts) {
                return;  // ← ショートカット無効時はスキップ
            }
            if (keyNavigator.isActive()) {
                keyNavigator.destroy();
            }
            keyNavigator.init();
        })
        // ...
}
```

### 修正案E: `getActualKey()` の改善

`event.key` を優先的に使用するよう `getActualKey()` を修正し、非推奨の `event.which`/`event.keyCode` への依存を減らす。

```javascript
function getActualKey(event) {
    // event.key を優先使用
    if (event.key) {
        const key = event.key.toLowerCase();
        return translateKeys[key] || key;
    }
    // フォールバック: event.which / event.keyCode
    const code = event.which || event.keyCode;
    return specialKeys[code] || '';
}
```

---

## 参考リンク

- [TAO Test Runner Plugins Wiki](https://github.com/oat-sa/extension-tao-testqti/wiki/Test-Runner-Plugins)
- [TAO Test Runner Config Wiki](https://github.com/oat-sa/extension-tao-testqti/wiki/Test-Runner-Config)
- [tao-test-runner-qti-fe リポジトリ](https://github.com/oat-sa/tao-test-runner-qti-fe)
- [tao-core-ui-fe リポジトリ](https://github.com/oat-sa/tao-core-ui-fe)
- [tao-core-sdk-fe リポジトリ](https://github.com/oat-sa/tao-core-sdk-fe)
- [RegisterTestRunnerPlugins.php](https://github.com/oat-sa/extension-tao-testqti/blob/master/scripts/install/RegisterTestRunnerPlugins.php)
- [MDN: KeyboardEvent.keyCode (非推奨)](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/keyCode)
