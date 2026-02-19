/**
 * サンプル PCI インタラクション - taoKeyEventGuard の組み込み例
 *
 * TAO PCI (Portable Custom Interaction) の initialize() メソッド内で
 * taoKeyEventGuard を初期化し、destroy() で解放するパターンを示す。
 *
 * このサンプルは自社 IME を使用する contenteditable ベースの PCI を想定している。
 *
 * DOM 構造:
 *   .qti-customInteraction          ← TAO が管理（navigableDomElement のラップ対象候補）
 *     └── dom (PCI root)            ← ② ガードハンドラ (taoKeyEventGuard)
 *           └── .my-ime-input       ← ① IME ハンドラ（自社 IME）
 *
 * イベントフロー (bubble フェーズ):
 *   .my-ime-input(①) → dom(②: stopPropagation) → TAO(③: 到達しない)
 */
define([
    'path/to/taoKeyEventGuard'
], function (taoKeyEventGuard) {
    'use strict';

    return {
        /**
         * PCI のエントリポイント。TAO ランタイムから呼ばれる。
         *
         * @param {string} id - インタラクション ID
         * @param {HTMLElement} dom - PCI ルート要素
         * @param {Object} config - PCI 設定
         * @param {Object} [state] - 復元用の保存状態
         */
        initialize: function (id, dom, config, state) {
            // ==========================================================
            // 1. TAO キーイベントガードの初期化
            //    PCI root で矢印キーと IME イベントの伝播を遮断する
            // ==========================================================
            this._guard = taoKeyEventGuard.init(dom);

            // ==========================================================
            // 2. IME 入力要素の作成
            // ==========================================================
            var imeInput = document.createElement('div');
            imeInput.setAttribute('contenteditable', 'true');
            imeInput.className = 'my-ime-input';
            imeInput.setAttribute('role', 'textbox');
            imeInput.setAttribute('aria-label', config.label || 'テキスト入力');
            dom.appendChild(imeInput);
            this._imeInput = imeInput;

            // ==========================================================
            // 3. IME コンポジション状態の追跡
            //
            //    event.isComposing / keyCode===229 のフォールバックに加えて
            //    compositionstart/compositionend を自前追跡する理由:
            //    - compositionstart 前の最初の keydown は isComposing=false
            //    - Chrome は compositionend 後に疑似 keydown を発火する
            //    - 自社 IME がブラウザの composition イベントとタイミングがずれる場合
            // ==========================================================
            this._isComposing = false;
            var self = this;

            imeInput.addEventListener('compositionstart', function () {
                self._isComposing = true;
            });
            imeInput.addEventListener('compositionend', function () {
                self._isComposing = false;
            });

            // ==========================================================
            // 4. IME 入力要素のキーハンドラ
            //    IME コンポジション中の矢印キーを消化する
            // ==========================================================
            imeInput.addEventListener('keydown', function (event) {
                if (self._isComposing || event.isComposing || event.keyCode === 229) {
                    if (taoKeyEventGuard.isArrowKey(event)) {
                        self._handleIMECursorMove(event.key);
                        event.preventDefault();
                        // stopPropagation は不要: ガード（dom 要素）が止める
                        return;
                    }
                }
                // IME 非コンポジション中のキー操作は
                // ネイティブの contenteditable 動作に任せる
            });

            // ==========================================================
            // 5. 保存状態の復元
            // ==========================================================
            if (state && state.response) {
                imeInput.textContent = state.response;
            }
        },

        /**
         * IME コンポジション中の矢印キーに対するカーソル移動処理。
         * 自社 IME の実装に合わせてカスタマイズする。
         *
         * @param {string} key - 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
         * @private
         */
        _handleIMECursorMove: function (key) {
            // 自社 IME のカーソル移動ロジックをここに実装
            switch (key) {
                case 'ArrowLeft':
                    // 例: 変換候補内のカーソルを左に移動
                    break;
                case 'ArrowRight':
                    // 例: 変換候補内のカーソルを右に移動
                    break;
                case 'ArrowUp':
                    // 例: 候補リストを上にスクロール
                    break;
                case 'ArrowDown':
                    // 例: 候補リストを下にスクロール
                    break;
            }
        },

        /**
         * PCI の回答を返す。TAO ランタイムから呼ばれる。
         *
         * @returns {Object} QTI baseType に準拠した回答オブジェクト
         */
        getResponse: function () {
            return {
                base: {
                    string: this._imeInput ? this._imeInput.textContent : ''
                }
            };
        },

        /**
         * PCI の状態をシリアライズして返す。TAO ランタイムから呼ばれる。
         *
         * @returns {string} JSON 文字列
         */
        getSerializedState: function () {
            return JSON.stringify({
                response: this._imeInput ? this._imeInput.textContent : ''
            });
        },

        /**
         * PCI を破棄する。TAO ランタイムから呼ばれる。
         * ガードの解放を忘れるとリスナーがリークする。
         */
        destroy: function () {
            if (this._guard) {
                this._guard.destroy();
                this._guard = null;
            }
            this._imeInput = null;
        }
    };
});
