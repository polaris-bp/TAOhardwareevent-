# TAO CBT システム 矢印キー問題 調査報告書

## 1. エグゼクティブサマリー

| 項目 | 内容 |
|---|---|
| **対象システム** | TAO CBT テストランナー（受験画面） |
| **問題** | PCI（カスタムインタラクション）内でハードウェアキーボードの矢印キーが効かない |
| **影響** | 自社 IME のカーソル移動・候補選択が不能になり、受験者の入力操作が妨害される |
| **根本原因** | TAO の keydown イベント処理における 3 つの欠陥の連鎖（後述） |
| **採用した対策** | PCI の `initialize()` で矢印キーの `stopPropagation()` を実行（5 行追加） |
| **TAO 側の変更** | 不要 |

---

## 2. 問題の概要

TAO テストランナーの受験画面には「キーナビゲーション」という機能があり、矢印キーで画面上のフォーカスを移動できる。この機能が PCI（Portable Custom Interaction＝カスタム問題タイプ）内の矢印キー操作と衝突し、以下の症状が発生する。

**発生する症状:**
- PCI 内の `contenteditable` 要素でカーソルが動かない
- IME コンポジション中に矢印キーで候補選択ができない
- 矢印キーを押すとフォーカスが PCI 外に飛んでしまう

**再現条件が不安定な理由:**
IME コンポジション中の矢印キーの `keyCode` はブラウザ・OS・IME の組み合わせにより異なる。`keyCode=229` の場合は TAO がスルーして正常動作するが、実際のキーコード（37〜40）が返る環境では TAO がインターセプトして問題が発生する。

---

## 3. 原因の詳細

TAO の keydown イベント処理パイプラインに **3 つの欠陥** がある。これらが連鎖して PCI 内の矢印キー操作を妨害する。

### 処理の流れと欠陥の関係

```
受験者が PCI 内で矢印キーを押す
    │
    ▼
[registry.js] onKeyboard(event)
    │
    │  ★ 欠陥1: IME コンポジション判定なし
    │     → IME 操作中の矢印キーもショートカットとして処理される
    │
    ▼
[registry.js] processShortcut()
    │
    │  ★ 欠陥2: stopPropagation() をハンドラ実行前に呼ぶ
    │     → ハンドラが「処理不要」と判断しても、伝播は既に止まっている
    │
    ▼
[navigableDomElement.js] 矢印キーハンドラ
    │
    │  ★ 欠陥3: isInput() が PCI のカスタム要素を認識しない
    │     → contenteditable 等が入力欄と判定されず、矢印キーを横取り
    │
    ▼
結果: preventDefault() でネイティブ動作がブロック
      keyboard() で TAO のフォーカス移動が発生
      → PCI 内の矢印キー操作が完全に妨害される
```

### 欠陥1: IME コンポジション状態の無視

**場所:** `tao-core-sdk-fe/src/util/shortcut/registry.js` の `onKeyboard()`

```javascript
function onKeyboard(event) {
    // ★ event.isComposing のチェックが存在しない
    processShortcut(event, { /* ... */ });
}
```

MDN が推奨する `event.isComposing || event.keyCode === 229` のチェックが欠落している。IME 変換中の矢印キーもショートカットとしてマッチし、処理されてしまう。

### 欠陥2: stopPropagation() の早すぎる実行

**場所:** `tao-core-sdk-fe/src/util/shortcut/registry.js` の `processShortcut()`

```javascript
function processShortcut(event, descriptor) {
    const shortcut = shortcuts[command];
    if (shortcut && !states.disabled) {
        // ★ ハンドラ実行「前」に stopPropagation
        if (shortcut.options.propagate === false) {
            event.stopPropagation();  // ← ここで伝播が止まる
        }
        // ハンドラの実行（isInput() 判定はここの中）
        _.forEach(handlers, function(handler) { handler(event, command); });
    }
}
```

矢印キーは `{ propagate: false }` で登録されている。ハンドラ内で「この要素は入力欄なので処理をスキップする」と判断しても、その前に `stopPropagation()` が実行済みのため、イベントは失われる。

### 欠陥3: isInput() の判定範囲が狭い

**場所:** `tao-core-ui-fe/src/keyNavigation/navigableDomElement.js`

```javascript
const isInput = $el => $el.is(':text,textarea');
```

`<input type="text">` と `<textarea>` しか入力欄と認識しない。PCI で使われる以下の要素は判定から漏れる:

- `<div contenteditable="true">`（MathQuill 等の数式入力）
- `<input type="number">`, `<input type="search">` 等
- カスタム Web Components、`<canvas>` ベースの入力

---

## 4. 「ショートカット設定オフ」との関係

CBT システム側で「ショートカット設定をオフ」にすると矢印キーが正常動作した事象が確認されているが、ソースコード追跡の結果、以下のことが判明した。

### `allow-shortcuts: false` は矢印キーに効かない

TAO には 2 種類の shortcutRegistry が存在する:

| registry | バインド先 | 登録キー | `allow-shortcuts` の影響 |
|---|---|---|---|
| グローバル singleton | `window` | J / K / C 等の汎用キー | **あり**（登録をスキップ） |
| 要素別インスタンス | 各 DOM 要素 | **矢印キー・Tab・Enter** | **なし** |

矢印キーは要素別インスタンスに登録されるため、`allow-shortcuts` の設定に関係なく常にアクティブになる。

### 実際に効いていたのは keyNavigation プラグインの無効化

「ショートカット設定オフ」で矢印キーが効いた事象は、`allow-shortcuts: false` ではなく **keyNavigation プラグイン自体の非活性化** (`'keyNavigation' => ['active' => false]`) が行われていたと推定する。プラグインがロードされなければ、矢印キーの shortcutRegistry 登録自体が行われない。

---

## 5. 採用した対策

### 方針

PCI の `initialize()` でルート要素に keydown リスナーを登録し、矢印キーイベントが TAO 側に伝播しないよう遮断する。

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

### なぜこれで解決するか

```
DOM ツリー（外側 → 内側）:

  .qti-item（テストランナー管理）
    └── .qti-customInteraction
          ← TAO の shortcutRegistry がここに登録
        └── PCI ルート要素 (dom)
              ← ★ ここで stopPropagation して遮断
            └── カスタム入力要素 (contenteditable 等)

keydown バブリング:
  入力要素 → PCI root (★遮断) ╳→ TAO shortcutRegistry(到達しない)
```

- `stopPropagation()` により、イベントが TAO の shortcutRegistry に到達しない
- TAO の `preventDefault()` も `keyboard()` も実行されない
- PCI 側は `preventDefault()` を呼んでいないため、ネイティブ動作（カーソル移動等）は維持される

### この対策のメリット

| メリット | 説明 |
|---|---|
| TAO のコード変更が不要 | PCI 側の変更だけで完結する |
| 実装が最小限 | `initialize()` に 5 行追加するだけ |
| 3 つの欠陥を一括回避 | イベントが TAO に到達しないため、全ての欠陥の影響を受けない |
| IME の状態に依存しない | 矢印キーかどうかのみで判定するため、再現条件の不安定さに影響されない |
| PCI 外に副作用なし | `stopPropagation` は PCI 内部から外への伝播のみ遮断 |

### 副作用の評価

**問題が起きないもの:**

| 操作 | 理由 |
|---|---|
| PCI 内のカーソル移動 | `preventDefault()` を呼んでいないため維持 |
| PCI 内の `<select>`, `<input>` 等 | 同上 |
| Tab / Shift+Tab のフォーカス移動 | 遮断対象外のため通過 |
| PCI 外の TAO ナビゲーション | PCI 外には影響なし |

**許容する副作用:**

| 副作用 | 影響度 | 備考 |
|---|---|---|
| PCI 内での TAO 矢印キーナビゲーション無効化 | 低 | Tab キーで代替可能 |
| TAO が将来矢印キーに新機能追加した場合 PCI 内で使えない | 低 | 将来リスクとして認識 |

---

## 6. 不採用とした対策

### PCI 側の代替案

| 対策 | 概要 | 不採用の理由 |
|---|---|---|
| **CSSクラス `no-key-navigation`** | TAO のナビゲーションアクションをブロック | `stopPropagation()` と `preventDefault()` は `processShortcut()` 内で先に実行されるため、ネイティブ動作は依然としてブロックされる |
| **CSSクラス `key-navigation-scrollable`** | `preventDefault()` の回避 | `stopPropagation()` は依然として呼ばれ、`keyboard()` によるフォーカス移動も実行される |
| **両者の組み合わせ** | 上記 2 つの併用 | `stopPropagation()` を回避できない |

### 対策比較表

| 対策 | TAO変更 | preventDefault回避 | stopPropagation回避 | ナビゲーション停止 | IME対応 |
|---|---|---|---|---|---|
| **PCI内 stopPropagation（採用）** | 不要 | **○** | **○** | **○** | **○** |
| no-key-navigation | 不要 | × | × | ○ | × |
| key-navigation-scrollable | 不要 | ○ | × | × | × |
| 両方の組み合わせ | 不要 | ○ | × | ○ | △ |

### keyNavigation プラグイン無効化との比較

| 観点 | プラグイン無効化 | PCI 内 stopPropagation（採用） |
|---|---|---|
| TAO 側の設定変更 | **必要**（TAO 管理者依存） | 不要 |
| PCI 開発者が制御可能か | いいえ | **はい** |
| 影響範囲 | テスト全体のキーボードナビ喪失 | **矢印キーのみ、PCI 内のみ** |
| アクセシビリティ（WCAG） | 準拠不可 | PCI 外は維持 |
| TAO アップデート時の再設定リスク | あり | なし（PCI コードに内包） |

---

## 7. TAO 開発元への改善提案（参考）

自社 PCI は上記の採用対策で対応するが、TAO エコシステム全体の改善として以下を提案できる。

| 優先度 | 提案内容 | 変更箇所 | 概要 |
|---|---|---|---|
| **高** | IME コンポジションガード追加 | `registry.js` | `event.isComposing \|\| event.keyCode === 229` のチェックを追加（2行） |
| **高** | 上記 + isInput() 拡大の組合せ | `registry.js` + `navigableDomElement.js` | 最も包括的な修正 |
| 中 | `isInput()` の判定範囲拡大 | `navigableDomElement.js` | `contenteditable` や PCI 内要素も入力欄として認識 |
| 低 | keyNavigation プラグイン無効化 | PHP 設定ファイル | 即効性はあるがアクセシビリティ喪失 |
| 非推奨 | stopPropagation タイミング変更 | `registry.js` | 根本修正だが回帰リスクが高い |

---

## 8. 拡張テキストインタラクションで矢印キーが正常動作する理由

### 事象

TAO の標準インタラクションである **拡張テキストインタラクション**（`extendedTextInteraction`）では、矢印キーによるカーソル移動が正常に動作する。一方、PCI（カスタムインタラクション）では同じ矢印キー操作が妨害される。

### 原因: `isInput()` の判定結果の違い

この差異は、欠陥3 で示した `isInput()` の判定結果に直結する。

```javascript
// navigableDomElement.js
const isInput = $el => $el.is(':text,textarea');
```

矢印キーハンドラは `isInput()` が `true` を返すと**処理全体をスキップ**する:

```javascript
.add('up down left right', (e, key) => {
    const $target = $(e.target);
    if (!isInput($target)) {       // true → スキップ、false → 横取り
        e.preventDefault();        // ネイティブ動作ブロック
        keyboard(key, e.target);   // TAO フォーカス移動
    }
}, { propagate: false })
```

### 拡張テキストインタラクションの場合（正常動作）

拡張テキストインタラクションは **プレーンテキストモード** では `<textarea>` を描画する:

```html
<!-- ExtendedTextInteraction のレンダリング結果 -->
<textarea class="text-container text-plain solid" ...></textarea>
```

| 判定 | 結果 | 理由 |
|---|---|---|
| `$el.is(':text,textarea')` | **true** | `<textarea>` は `:textarea` にマッチ |
| `isInput()` | **true** | → ハンドラ本体がスキップされる |
| `preventDefault()` | **呼ばれない** | → ネイティブカーソル移動が維持 |
| `keyboard()` | **呼ばれない** | → TAO フォーカス移動も発生しない |

さらに **XHTML モード**（リッチテキスト）では CKEditor を使用し、`<div contenteditable="true">` を描画するが、TAO は CKEditor コンテナに `no-key-navigation` クラスを明示的に付与している:

```javascript
// ExtendedTextInteraction.js（XHTML モード）
if (editor.container && editor.container.$) {
    $(editor.container.$).addClass('no-key-navigation');
}
```

この `no-key-navigation` クラスにより、`allowedToNavigateFrom()` が `false` を返し、キーナビゲーションのアクション（フォーカス移動）がブロックされる。

### PCI の場合（問題発生）

PCI は開発者が自由に DOM を構築する。自社 IME が使う `<div contenteditable="true">` の場合:

```html
<!-- PCI のカスタム DOM -->
<div contenteditable="true" class="my-ime-input"></div>
```

| 判定 | 結果 | 理由 |
|---|---|---|
| `$el.is(':text,textarea')` | **false** | `<div>` は `:text` にも `:textarea` にもマッチしない |
| `isInput()` | **false** | → ハンドラ本体が実行される |
| `preventDefault()` | **呼ばれる** | → ネイティブカーソル移動がブロック |
| `keyboard()` | **呼ばれる** | → TAO フォーカス移動が発生 |

### まとめ: なぜ差が生じるか

```
拡張テキスト (textarea):
  矢印キー → isInput()=true → スキップ → ネイティブ動作維持 ✓

拡張テキスト (CKEditor/XHTML):
  矢印キー → isInput()=false → ハンドラ実行
    → allowedToNavigateFrom()=false (no-key-navigation) → 移動ブロック ✓

PCI (contenteditable):
  矢印キー → isInput()=false → ハンドラ実行
    → preventDefault() + keyboard() → ネイティブ動作ブロック ✗
```

つまり、TAO は自身の標準インタラクションには個別の保護措置（`<textarea>` の型判定、CKEditor の `no-key-navigation` クラス）を講じているが、PCI にはそのような保護が存在しない。PCI 開発者が TAO の内部実装を知らない限り、この問題を回避することは困難である。

---

## 9. GitHub 上の開発者のやりとり・推奨設定の調査

### 調査範囲と方法

以下のリポジトリの全 Pull Request（計 2,000 件超）を対象に、`keyNavigation`、`keyboard`、`arrow`、`PCI`、`shortcut`、`navigableDomElement`、`isInput`、`avoidInput`、`stopPropagation`、`IME`、`no-key-navigation`、`key-navigation-scrollable`、`allow-shortcuts` 等のキーワードで網羅的に検索した:

- `oat-sa/tao-test-runner-qti-fe`（548 PRs）
- `oat-sa/tao-core-ui-fe`（689 PRs）
- `oat-sa/tao-core-sdk-fe`（211 PRs）
- `oat-sa/extension-tao-testqti`
- `oat-sa/tao-core`
- `oat-sa/extension-tao-itemqti`
- `oat-sa/tao-item-runner-qti-fe`

**oat-sa 組織は GitHub Issues を使用しておらず、Jira（TAO-XXXX, TCA-XXX, ACTP-XXX, TR-XXX 等）で管理している。** そのため全ての技術的議論は PR の説明文とコミットメッセージに記録されている。

### 9.1 PCI とキーボードナビゲーションの衝突に直接関わる PR

#### TR-84: PCI の keyNavigation インジケータ除外（2020年11月）

| リポジトリ | PR | 概要 |
|---|---|---|
| `tao-test-runner-qti-fe` | [#340](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/340) | `.qti-customInteraction` を keyNavigation インジケータスタイルから除外 |
| `tao-core-ui-fe` | [#216](https://github.com/oat-sa/tao-core-ui-fe/pull/216) | PCI が動的に DOM を削除した際の focusout 問題を MutationObserver で修正（Firefox 固有） |
| `extension-tao-testqti` | [#1944](https://github.com/oat-sa/extension-tao-testqti/pull/1944) | 依存関係更新 |

**意味:** OAT 社は PCI（`.qti-customInteraction`）を keyNavigation の視覚的なフォーカスインジケータから明示的に除外した。**PCI は TAO の keyNavigation にとって不透明なコンテナとして扱うべき** という設計意図が読み取れる。しかし、インジケータのスタイル除外だけであり、キーイベントの横取り（`stopPropagation`、`preventDefault`）は修正されていない。

#### TAO-6409: CKEditor に `no-key-navigation` クラスを付与（2019年1月）

| リポジトリ | PR | 概要 |
|---|---|---|
| `extension-tao-itemqti` | [#1217](https://github.com/oat-sa/extension-tao-itemqti/pull/1217) | 拡張テキストの CKEditor コンテナに `no-key-navigation` クラスを付与 |
| `extension-tao-testqti` | [#1369](https://github.com/oat-sa/extension-tao-testqti/pull/1369) | CKEditor ツールバー内の Tab キー動作修正 |
| `tao-core` | [#1924](https://github.com/oat-sa/tao-core/pull/1924) | CKEditor ツールバーレイアウト修正 |

**意味:** TAO は拡張テキストインタラクション（XHTML モード）で CKEditor を使う際、keyNavigation との衝突を `no-key-navigation` クラスで回避した。**これは TAO 開発者自身が keyNavigation とリッチテキスト編集の衝突を認識し、CSS クラスベースの回避策を実装した前例** である。しかし、この回避策は PCI には適用されていない。

#### INF-209: キーボード選択時のバリデーション不備（2025年3月）

| リポジトリ | PR | 概要 |
|---|---|---|
| `tao-item-runner-qti-fe` | [#424](https://github.com/oat-sa/tao-item-runner-qti-fe/pull/424) | Space キーによる選択時に maxChoices バリデーションが効かない問題を修正 |

**意味:** 2025 年時点でもキーボード操作固有のバグが発見されており、キーボードイベント処理の網羅性に課題が残っていることを示す。

### 9.2 keyNavigation の設計と進化

keyNavigation プラグインは 2016 年から継続的に開発されている。以下は主要な設計変更の時系列である:

| 時期 | Jira | PR | 変更内容 |
|---|---|---|---|
| 2016-10 | TAO-3251 | [extension-tao-testqti#622](https://github.com/oat-sa/extension-tao-testqti/pull/622) | `allow-shortcuts` オプション導入 |
| 2016-11 | TAO-3398 | [extension-tao-testqti#653](https://github.com/oat-sa/extension-tao-testqti/pull/653) | `responsesAccess` プラグインを `keyNavigation` にリネーム |
| 2017-02 | TAO-3738 | [tao-core#1175](https://github.com/oat-sa/tao-core/pull/1175) | `keyNavigator` ライブラリの初期実装 |
| 2017-02 | TAO-3738 | [tao-core#1190](https://github.com/oat-sa/tao-core/pull/1190) | `navigableDomElement`・`navigableGroupElement` 概念の導入 |
| 2017-03 | TAO-3946 | [extension-tao-testqti#773](https://github.com/oat-sa/extension-tao-testqti/pull/773) | 階層的キーナビゲーション |
| 2019-01 | TAO-6409 | [extension-tao-itemqti#1217](https://github.com/oat-sa/extension-tao-itemqti/pull/1217) | CKEditor に `no-key-navigation` クラス適用 |
| 2019-11 | TAO-9506 | [tao-test-runner-qti-fe#85](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/85) | **`contentNavigatorType: 'native'` モード追加** |
| 2020-03 | ACTP-297 | [tao-test-runner-qti-fe#139](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/139), [#150](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/150) | **プラグインをストラテジー/モード構成に大規模リファクタリング** |
| 2020-04 | ACTP-429 | [tao-core-ui-fe#117](https://github.com/oat-sa/tao-core-ui-fe/pull/117), [tao-test-runner-qti-fe#159](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/159) | **[破壊的変更] navigableDomElement にキーボード管理を移動、現行アーキテクチャ確立** |
| 2020-05 | TCA-557 | [tao-test-runner-qti-fe#209](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/209) | native モードで矢印キーをラジオボタン/リスト用に使用 |
| 2020-06 | TCA-634 | [tao-core-ui-fe#144](https://github.com/oat-sa/tao-core-ui-fe/pull/144) | **`key-navigation-scrollable-*` CSS クラス導入** |
| 2020-06 | TCA-595 | [tao-test-runner-qti-fe#224](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/224) | WCAG 準拠のラジオボタン矢印キーナビゲーション |
| 2020-11 | TR-84 | [tao-test-runner-qti-fe#340](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/340) | **PCI を keyNavigation インジケータから除外** |

### 9.3 `contentNavigatorType: 'native'` モード

TAO-9506（2019年11月）で導入された設定で、keyNavigation のナビゲーションモードを変更できる:

```php
// config/taoQtiTest/testRunner.conf.php
'keyNavigation' => array(
    'contentNavigatorType' => 'native'  // 'default' | 'linear' | 'native'
)
```

| モード | グループ間移動 | グループ内移動 | 矢印キーの用途 |
|---|---|---|---|
| `default` | Tab / Shift+Tab | **矢印キー** | フォーカス移動 |
| `linear` | Tab / Shift+Tab | **矢印キー** | フォーカス移動 |
| `native` | Tab / Shift+Tab | Tab / Shift+Tab | **ラジオボタン・リスト項目の選択のみ** |

**`native` モードにすると、矢印キーはラジオボタンとリスト項目の選択にのみ使われ、一般的なフォーカス移動には Tab/Shift+Tab が使われる。**

ただし、`native` モードでも `navigableDomElement` の矢印キーハンドラ自体は登録される。ラジオボタン内の矢印キーは WCAG 準拠の動作（TCA-595）として処理されるが、PCI 内の `contenteditable` 等に対する `isInput()` の判定問題は `native` モードでも変わらない。

**本問題への影響: `native` モードは部分的に有効だが、完全な解決にはならない。**

### 9.4 CSS クラスベースの回避策

keyNavigation が提供する CSS クラスと、その導入経緯・PCI での有効性:

| クラス名 | 導入 PR | 効果 | PCI での有効性 |
|---|---|---|---|
| `no-key-navigation` | TAO-6409 ([itemqti#1217](https://github.com/oat-sa/extension-tao-itemqti/pull/1217)) | `allowedToNavigateFrom()` → false、ナビゲーション停止 | **部分的** — `stopPropagation` と `preventDefault` は `processShortcut` 内で先に実行済みのため、ネイティブ動作はブロックされたまま |
| `key-navigation-scrollable` | TCA-634 ([core-ui-fe#144](https://github.com/oat-sa/tao-core-ui-fe/pull/144)) | 全矢印キーの `preventDefault()` をスキップ | **部分的** — `stopPropagation` は依然として実行、`keyboard()` も呼ばれる |
| `key-navigation-scrollable-up` | 同上 | 上・左矢印の `preventDefault()` をスキップ | 同上 |
| `key-navigation-scrollable-down` | 同上 | 下・右矢印の `preventDefault()` をスキップ | 同上 |
| `key-navigation-actionable` | 同上 | Enter キーの `preventDefault()` をスキップ | Enter キーのみ |

**いずれの CSS クラスも PCI に自動付与されない。** また、PCI 開発者向けドキュメントにこれらのクラスの存在は記載されていない。

### 9.5 テストランナー設定と本問題への影響

| 設定項目 | デフォルト値 | 矢印キー問題への影響 | 根拠 |
|---|---|---|---|
| `allow-shortcuts` | `true` | **効果なし** | 矢印キーは要素別 registry で管理（第4章参照） |
| `keyNavigation.contentNavigatorType` | `'default'` | **部分的** | `native` にするとフォーカス移動は Tab のみになるが、`isInput()` の問題は残る |
| `keyNavigation` plugin `active` | `true` | **完全に解消** | プラグイン無効化でナビゲーション全体が停止。ただしアクセシビリティ喪失 |

### 9.6 PCI 開発ドキュメントの状況

| ドキュメント | URL | キーボード対策の記述 |
|---|---|---|
| PCI Development Guide | [taohub-articles/forge/pci-development.md](https://github.com/oat-sa/taohub-articles/blob/master/forge/pci-development.md) | **なし** |
| TAO PCI Specification | [taohub-articles/forge/QTI/tao-pci.md](https://github.com/oat-sa/taohub-articles/blob/master/forge/QTI/tao-pci.md) | **なし** |
| Test Runner Config Wiki | [extension-tao-testqti/wiki/Test-Runner-Config](https://github.com/oat-sa/extension-tao-testqti/wiki/Test-Runner-Config) | **なし** |
| Test Runner Plugins Wiki | [extension-tao-testqti/wiki/Test-Runner-Plugins](https://github.com/oat-sa/extension-tao-testqti/wiki/Test-Runner-Plugins) | **なし** |

PCI 開発者向けドキュメントには、キーボードイベントの処理方法、TAO の keyNavigation との共存方法、推奨する CSS クラスの使用方法について**一切記載がない**。

### 9.7 keyNavigation プラグインの開発者・関係者情報

| 人物 | 役割 | 主な PR |
|---|---|---|
| Jean-Sebastien Conan (jsconan) | keyNavigation アーキテクト、プラグイン作者 | ACTP-297 リファクタリング、ACTP-429 破壊的変更、TCA-634 scrollable クラス、TCA-557/595 ラジオボタン改善 |
| zagovorichev | 初期実装 | TAO-8693 初期ナビゲーション、TAO-8933 keyNavigation 修正 |
| bziondik | native モード | TAO-9506 `contentNavigatorType: 'native'` |
| btamas | PCI 対応 | TR-84 PCI インジケータ除外、focusout MutationObserver |
| atsymuk | アクセシビリティ | TCA-665 KB ナビゲーション修正、TCA-590 ショートカットオーバーレイ |
| ampaveliev | ツールメニュー | ACTP-410 ツールキーボードナビゲーション |
| lecosson | カスタムナビゲーション | TR-199 フラットラジオ、TCA-741 ショートカット |

### 9.8 GitHub 調査で判明しなかったこと

以下のキーワードで検索したが、**oat-sa の全リポジトリで該当する PR・Issue は 0 件** だった:

| 検索キーワード | 結果 | 意味 |
|---|---|---|
| `isInput` | 0 件 | `isInput()` の判定範囲の狭さは議論されたことがない |
| `avoidInput` | 0 件 | `avoidInput` オプションの制限は議論されたことがない |
| `stopPropagation keyboard` | 0 件 | `stopPropagation` のタイミング問題は議論されたことがない |
| `IME` | 0 件 | IME コンポジションとの衝突は認識されていない |
| `allowedToNavigateFrom` | 0 件 | この関数の制限は議論されたことがない |
| `PCI keyboard` | 0 件 | PCI 内のキーボード問題は報告されたことがない |

### 9.9 この調査からの総合的示唆

1. **OAT 社は keyNavigation とインタラクションの衝突を認識している** — CKEditor への `no-key-navigation` 付与（TAO-6409）、PCI のインジケータ除外（TR-84）、`key-navigation-scrollable-*` クラスの導入（TCA-634）など、衝突を回避する仕組みを複数実装している

2. **しかし PCI に対する保護は不完全** — 視覚インジケータの除外（TR-84）は行ったが、キーイベントの横取りは修正していない。`no-key-navigation` クラスは CKEditor にのみ適用され、PCI には適用も案内もされていない

3. **IME・`isInput()`・`stopPropagation` タイミングの問題は未認識** — これらのキーワードでの検索結果が 0 件であることから、本報告書で指摘する 3 つの欠陥は OAT 社内で認識されていないと判断できる

4. **`contentNavigatorType: 'native'` は有力な緩和策** — TAO-9506 で導入された設定で、矢印キーの用途をラジオボタン・リスト選択に限定できる。ただし `isInput()` の問題は残るため完全な解決にはならない

5. **PCI 開発者への情報提供が著しく不足** — TAO の keyNavigation との共存に関するガイダンスが公式ドキュメントに存在せず、`no-key-navigation` 等の CSS クラスの存在も文書化されていない

---

## 10. 調査対象ソースコード一覧

| リポジトリ | ファイル | 役割 |
|---|---|---|
| `tao-core-sdk-fe` | `src/util/shortcut/registry.js` | ショートカットキー登録・検出基盤 |
| `tao-core-ui-fe` | `src/keyNavigation/navigableDomElement.js` | DOM 要素レベルのキーイベント処理 |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/plugin.js` | キーナビゲーションプラグイン本体 |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/keyNavigation.js` | キーナビゲーション制御ロジック |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/helpers.js` | ナビゲーション判定ヘルパー |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/modes/defaultMode.js` | デフォルトモードキー設定 |
| `tao-test-runner-qti-fe` | `src/plugins/content/accessibility/keyNavigation/strategies/itemNavigation.js` | アイテム内ナビゲーション戦略 |
| `tao-test-runner-qti-fe` | `src/plugins/navigation/next.js` | 次問題ナビゲーション |
| `tao-item-runner-qti-fe` | `src/qtiCommonRenderer/renderers/interactions/ExtendedTextInteraction.js` | 拡張テキストインタラクション描画 |
| `tao-item-runner-qti-fe` | `src/qtiCommonRenderer/tpl/interactions/customInteraction.tpl` | PCI テンプレート |
| `extension-tao-testqti` | `config/default/testRunner.conf.php` | テストランナー設定 |
| `extension-tao-testqti` | `scripts/install/RegisterTestRunnerPlugins.php` | プラグイン登録 |

## 11. 参考リンク

### 本報告書で参照した主要 PR（oat-sa GitHub）

#### PCI・キーボード衝突
- [tao-test-runner-qti-fe#340](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/340) - TR-84: PCI を keyNavigation インジケータから除外
- [tao-core-ui-fe#216](https://github.com/oat-sa/tao-core-ui-fe/pull/216) - TR-84: PCI の focusout MutationObserver 修正
- [extension-tao-itemqti#1217](https://github.com/oat-sa/extension-tao-itemqti/pull/1217) - TAO-6409: CKEditor に `no-key-navigation` クラス付与
- [tao-item-runner-qti-fe#424](https://github.com/oat-sa/tao-item-runner-qti-fe/pull/424) - INF-209: キーボード選択時バリデーション修正（2025年）

#### keyNavigation アーキテクチャ
- [tao-core#1175](https://github.com/oat-sa/tao-core/pull/1175) - TAO-3738: keyNavigator 初期実装
- [tao-core#1190](https://github.com/oat-sa/tao-core/pull/1190) - navigableDomElement 概念導入
- [tao-core-ui-fe#117](https://github.com/oat-sa/tao-core-ui-fe/pull/117) - ACTP-429: [破壊的] 現行アーキテクチャ確立
- [tao-test-runner-qti-fe#139](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/139) - ACTP-297: プラグインリファクタリング第1フェーズ
- [tao-test-runner-qti-fe#150](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/150) - ACTP-297: ストラテジー/モード構成導入

#### ナビゲーションモード・設定
- [tao-test-runner-qti-fe#85](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/85) - TAO-9506: `contentNavigatorType: 'native'` 追加
- [tao-test-runner-qti-fe#209](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/209) - TCA-557: native モードでの矢印キー動作
- [tao-test-runner-qti-fe#224](https://github.com/oat-sa/tao-test-runner-qti-fe/pull/224) - TCA-595: WCAG ラジオボタンナビゲーション
- [tao-core-ui-fe#144](https://github.com/oat-sa/tao-core-ui-fe/pull/144) - TCA-634: `key-navigation-scrollable-*` CSS クラス導入
- [extension-tao-testqti#622](https://github.com/oat-sa/extension-tao-testqti/pull/622) - TAO-3251: `allow-shortcuts` オプション導入

### TAO ソースコード・ドキュメント
- [tao-test-runner-qti-fe](https://github.com/oat-sa/tao-test-runner-qti-fe) - テストランナー（keyNavigation プラグイン含む）
- [tao-core-ui-fe](https://github.com/oat-sa/tao-core-ui-fe) - コア UI（navigableDomElement 含む）
- [tao-core-sdk-fe](https://github.com/oat-sa/tao-core-sdk-fe) - コア SDK（shortcut registry 含む）
- [tao-item-runner-qti-fe](https://github.com/oat-sa/tao-item-runner-qti-fe) - QTI アイテムランナー（ExtendedTextInteraction 含む）
- [Test Runner Config Wiki](https://github.com/oat-sa/extension-tao-testqti/wiki/Test-Runner-Config) - テストランナー設定
- [Test Runner Plugins Wiki](https://github.com/oat-sa/extension-tao-testqti/wiki/Test-Runner-Plugins) - プラグイン一覧
- [PCI Development Guide](https://github.com/oat-sa/taohub-articles/blob/master/forge/pci-development.md) - PCI 開発ガイド
- [TAO PCI Specification](https://github.com/oat-sa/taohub-articles/blob/master/forge/QTI/tao-pci.md) - TAO PCI 仕様
- [RegisterTestRunnerPlugins.php](https://github.com/oat-sa/extension-tao-testqti/blob/master/scripts/install/RegisterTestRunnerPlugins.php) - プラグイン登録

### TAO リリースノート・ユーザーガイド
- [TAO 2024-11 LTS Release Notes](https://userguide.taotesting.com/release-notes/latest/public/2024-11-lts) - Order インタラクションのキーボード修正
- [TAO Keyboard Navigation Guide](https://www.taotesting.com/user-guide/users/taking-a-test/keyboard-navigation/) - 公式ショートカット一覧

### Web 標準・ブラウザ仕様
- [MDN: Element keydown event](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event) - isComposing の推奨パターン
- [MDN: KeyboardEvent.keyCode](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/keyCode) - keyCode（非推奨）
- [Mozilla Bug #1529467](https://bugzilla.mozilla.org/show_bug.cgi?id=1529467) - IME コンポジション中の矢印キー挙動
- [Mozilla Bug #1343451](https://bugzilla.mozilla.org/show_bug.cgi?id=1343451) - keyCode 229 の扱い

### IMS 仕様
- [IMS PCI Specification](https://www.imsglobal.org/sites/default/files/assessment/pciv1p0/pciv1p0.html)
