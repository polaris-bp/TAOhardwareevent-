/**
 * TAO Key Event Guard - PCI 内のキーイベントを TAO の keyNavigation から保護するモジュール
 *
 * TAO テストランナーの keyNavigation プラグインは、矢印キーの keydown イベントを
 * shortcutRegistry 経由でインターセプトし、stopPropagation() と preventDefault() を
 * 呼び出す。これにより PCI 内部の矢印キー操作（IME候補選択、カーソル移動等）が
 * 妨害される。
 *
 * このモジュールは PCI ルート要素に keydown リスナーを登録し、TAO の
 * shortcutRegistry ハンドラに到達する前にイベント伝播を遮断する。
 *
 * @example
 * // PCI の initialize() メソッド内で使用
 * define(['path/to/taoKeyEventGuard'], function(taoKeyEventGuard) {
 *     return {
 *         initialize: function(id, dom, config, state) {
 *             this._guard = taoKeyEventGuard.init(dom);
 *             // ... PCI の初期化処理 ...
 *         },
 *         destroy: function() {
 *             if (this._guard) {
 *                 this._guard.destroy();
 *                 this._guard = null;
 *             }
 *         }
 *     };
 * });
 *
 * @see INVESTIGATION_REPORT.md - 原因1〜3、PCI対策A
 */
define([], function () {
    'use strict';

    /**
     * TAO の shortcutRegistry が矢印キーのマッチングに使用するキー名。
     * registry.js の specialKeys マップ (37:'left', 38:'up', 39:'right', 40:'down') と
     * translateKeys マップ ('arrowdown':'down' 等) に対応する。
     *
     * @type {string[]}
     */
    var ARROW_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

    /**
     * IME コンポジション中かどうかを判定する。
     *
     * event.isComposing だけでは不十分なケースがある:
     * - compositionstart 前の最初の keydown: isComposing はまだ false
     * - compositionend 後の Chrome 疑似 keydown: isComposing が false
     * そのため keyCode === 229 をフォールバックとして併用する。
     *
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    function isIMEComposing(event) {
        return event.isComposing || event.keyCode === 229;
    }

    /**
     * イベントの key プロパティが矢印キーかどうかを判定する。
     *
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    function isArrowKey(event) {
        return ARROW_KEYS.indexOf(event.key) !== -1;
    }

    /**
     * PCI ルート要素にキーイベントガードを設定する。
     *
     * 動作原理:
     *   TAO の shortcutRegistry は addEventListener('keydown', handler, false) で
     *   navigableDomElement のラップ要素（PCI ルートの親または祖先）に登録される。
     *   PCI ルート要素のリスナーは bubble フェーズでそれより先に発火するため、
     *   stopPropagation() を呼ぶことで TAO のハンドラに到達させない。
     *
     * イベントフロー:
     *   入力要素 → PCI root (★ここで遮断) → TAO shortcutRegistry (到達しない)
     *
     * @param {HTMLElement} pciRootElement - PCI の initialize() で受け取る dom 引数
     * @param {Object} [options] - オプション設定
     * @param {boolean} [options.guardArrowKeys=true] - 矢印キーの伝播を遮断するか
     * @param {boolean} [options.guardIMEEvents=true] - IME コンポジション中の全キーの伝播を遮断するか
     * @param {string[]} [options.additionalKeys] - 追加で遮断するキー名の配列 (例: ['Escape'])
     * @returns {Object} destroy() メソッドを持つオブジェクト
     */
    function init(pciRootElement, options) {
        var config = {
            guardArrowKeys: true,
            guardIMEEvents: true,
            additionalKeys: []
        };

        // オプションのマージ
        if (options) {
            if (typeof options.guardArrowKeys === 'boolean') {
                config.guardArrowKeys = options.guardArrowKeys;
            }
            if (typeof options.guardIMEEvents === 'boolean') {
                config.guardIMEEvents = options.guardIMEEvents;
            }
            if (Array.isArray(options.additionalKeys)) {
                config.additionalKeys = options.additionalKeys;
            }
        }

        /**
         * PCI ルート要素の keydown ハンドラ。
         * TAO の shortcutRegistry ハンドラより先に発火し、条件に応じて伝播を遮断する。
         *
         * @param {KeyboardEvent} event
         */
        function onKeyDown(event) {
            // IME コンポジション中: 全キーイベントを TAO に渡さない
            // TAO の registry.js は event.isComposing をチェックしないため、
            // IME 変換中の矢印キーがショートカットとしてマッチしてしまう（原因1）
            if (config.guardIMEEvents && isIMEComposing(event)) {
                event.stopPropagation();
                return;
            }

            // 矢印キー: PCI 内の操作を優先し、TAO には渡さない
            // TAO の navigableDomElement は isInput() で contenteditable 等を
            // 認識しないため、PCI 内の矢印キー操作がブロックされる（原因2）
            if (config.guardArrowKeys && isArrowKey(event)) {
                event.stopPropagation();
                // ※ preventDefault() は呼ばない
                //    → contenteditable 内のネイティブカーソル移動を維持
                return;
            }

            // 追加キーの遮断
            if (config.additionalKeys.indexOf(event.key) !== -1) {
                event.stopPropagation();
                return;
            }

            // Tab, Shift+Tab, Enter, Space 等は遮断せず TAO に通す
            // → PCI↔テストランナーUI 間のキーボードナビゲーションを維持
        }

        // bubble フェーズで登録（TAO の shortcutRegistry と同じフェーズ）
        // PCI ルートは TAO のリスナー登録要素より内側にあるため、先に発火する
        pciRootElement.addEventListener('keydown', onKeyDown, false);

        return {
            /**
             * ガードを解除し、リスナーを除去する。
             * PCI の destroy() メソッドから呼び出すこと。
             */
            destroy: function () {
                pciRootElement.removeEventListener('keydown', onKeyDown, false);
            }
        };
    }

    return {
        init: init,
        isIMEComposing: isIMEComposing,
        isArrowKey: isArrowKey
    };
});
