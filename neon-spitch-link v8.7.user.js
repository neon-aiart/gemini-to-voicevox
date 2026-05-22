// ==UserScript==
// @name           ねおん すぴっち リンク
// @name:ja        ねおん すぴっち リンク
// @name:en        Neon Spitch Link
// @namespace      https://bsky.app/profile/neon-ai.art
// @homepage       https://github.com/neon-aiart
// @icon           data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💬</text></svg>
// @version        8.7-dev
// @description    Gemini/ChatGPTのお返事を、VOICEVOX＆RVCと連携して自動読み上げ！
// @description:ja Gemini/ChatGPTのお返事を、VOICEVOX＆RVCと連携して自動読み上げ！
// @description:en Seamlessly connect Gemini/ChatGPT responses to VOICEVOX & RVC for automatic speech synthesis.
// @author         ねおん
// @match          https://gemini.google.com/*
// @match          https://chatgpt.com/*
// @match          https://claude.ai/*
// @include        https://www.google.*/search*
// @include        https://x.com/*
// @include        https://grok.com/*
// @grant          GM_xmlhttpRequest
// @grant          GM_addStyle
// @grant          GM_getValue
// @grant          GM_setValue
// @grant          GM_deleteValue
// @grant          GM_registerMenuCommand
// @grant          GM_unregisterMenuCommand
// @connect        localhost
// @connect        trycloudflare.com
// @license        PolyForm Noncommercial 1.0.0; https://polyformproject.org/licenses/noncommercial/1.0.0/
// ==/UserScript==

/**
 * ==============================================================================
 * IMPORTANT NOTICE / 重要事項
 * ==============================================================================
 * Copyright (c) 2025 ねおん (Neon)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * * [JP] 本スクリプトは個人利用・非営利目的でのみ使用・改変が許可されます。
 * 無断転載、作者名の書き換え、およびクレジットの削除は固く禁じます。
 * 本スクリプトを改変・配布（フォーク）する場合は、必ず元の作者名（ねおん）
 * およびこのクレジット表記を維持してください。
 * * [EN] This script is licensed for personal and non-commercial use only.
 * Unauthorized re-uploading, modification of authorship, or removal of
 * author credits is strictly prohibited. If you fork this project, you MUST
 * retain the original credits and authorship.
 * ==============================================================================
 */

(function() {
    'use strict';

    const SCRIPT_VERSION = '8.7-dev';
    const STORE_KEY = 'gemini_voicevox_config';

    // ========= グローバルな再生・操作制御変数 =========
    let debounceTimerId = null;
    let currentAudio = null;
    let currentXhrs = [];               // 合成中のXHRを配列として定義（中断用）
    let isConversionStarting = false;   // 合成処理全体が開始したことを示すフラグ
    let isConversionAborted = false;    // 合成の中断要求があったかを示すフラグ
    let currentSpeakerNameXhr = null;   // スピーカー名取得用のXHR
    let isPlaying = false;
    let isPause = false;
    let lastAutoPlayedText = '';        // 最後に自動再生したテキストをキャッシュ
    const MAX_RETRY_COUNT = 3;          // 最大リトライ回数
    let toastTimeoutId = null;
    let isRvcModelLoading = false;      // RVCモデル情報のロード中フラグ（排他制御用）
    const DEFAULT_CHUNK_SIZE = 100;     // 初期チャンクサイズ
    const VOICEVOX_TIMEOUT_MS = 60000;  // 60秒 VOICEVOX/RVCのXHR通信タイムアウト値（ミリ秒）

    // ========= Web Audio API (ストリーミング再生) 関連 =========
    /** @type {AudioContext | null} Web Audio APIのコンテキスト。音の心臓部よ！*/
    let audioContext = null;
    /** @type {AudioBufferSourceNode | null} 現在再生中の音源ノード。停止に使うわ。*/
    let currentSourceNode = null;
    /** @type {number} 現在再生中のチャンクが終了する予定時刻（AudioContext.currentTimeを基準）。キューイングに使うわ。*/
    let nextStartTime = 0;
    /** @type {number} 全体のチャンク数。再生完了の判定に使うわ。*/
    let totalStreamingChunks = 0;
    /** @type {number} 現在再生が完了したチャンクの数。*/
    let finishedStreamingChunks = 0;
    /** @type {string | null} ストリーミング再生で使うためのキャッシュキー */
    let currentStreamingCacheKey = null;

    // ========= グローバルなキャッシュキー =========
    const LAST_CACHE_HASH = 'latest_audio_cache_hash'; // テキストと設定のハッシュを保存
    const LAST_CACHE_DATA = 'latest_audio_cache_data'; // Base64 WAVデータを保存

    // ========= 設定値の読み込み =========
    const DEFAULT_CONFIG = {
        iconMode: 'awesome',
        speakerId: 4,
        apiUrl: 'http://localhost:50021',
        autoPlay: true,
        minTextLength: 10,                   // 最小テキスト長 (0～10,000) [10]
        maxChunks: 100,                      // 最大チャンク数 (1～1,000) [100]
        shortcutKey: 'Ctrl+Shift+B',
        dlBtnEnabled: true,                  // ダウンロードボタン
        rvcEnabled: false,                   // RVC 連携スイッチ
        rvcApiUrl: 'http://localhost:7897/', // RVC API URL
        rvcModel: 'rvcModel.pth',            // RVC モデルファイル名
        rvcIndex: '',                        // RVC インデックスファイル名
        rvcPitch: 0,                         // RVC ピッチ (-12～12)
        rvcRatio: 0.75,                      // RVC 検索特徴率
        rvcAlgorithm: 'rmvpe',               // RVC ピッチ抽出アルゴリズム (pm|harvest|crepe|rmvpe)
        rvcResample: 48000,                  // リサンプリング (0～48000) [48000]
        /* ここから設定UIに入ってない初期値をそのまま使う項目 */
        speedScale: 1.0,                     // 速度 (0.0～)
        pitchScale: 0.0,                     // ピッチ (-0.15～0.15)
        intonationScale: 1.0,                // 抑揚 (0.0～)
        volumeScale: 1.0,                    // 音量 (0.0～)
        rvcNumber: 0,                        // 話者ID (0～112)
        rvcEnvelope: 0.25,                   // 入力ソースと出力の音量エンベロープの融合率 (0～1)
        rvcArtefact: 0.33,                   // 明確な子音と呼吸音を保護 (0～0.5)
        rvcMedianFilter: 3,                  // ミュートを減衰させるためのメディアンフィルタ (0～7)

        // Gemini/ChatGPTは1000, AIモード/Grokは200で安定 (ミリ秒)
        debounceDelay: 200,

        // クエリ検索（コンテナ・フッター）
        selectorsResponse: [ {
            // Gemini
            container: 'response-container',
            footer: '.more-menu-button-container',
        }, {
            // ChatGPT
            container: 'section[data-turn="assistant"]',
            footer: 'button',
        }, {
            // Claude
            container: 'div.group:has(div.contents)',
            footer: 'button[data-testid="action-bar-copy"]',
        }, {
            // Google AIモード
            container: 'div[data-container-id="main-col"]',
            footer: 'button',
        }, {
            // Grok
            container: 'div[id^="response-"].items-start',
            footer: '.group-focus-within\\:opacity-100',
        }, {
            // x.com/i/grok*
            container: 'div.r-16lk18l.r-13qz1uu',
            footer: 'div.r-18u37iz.r-1jnkns4',
        }, {
            // x.com/i/grok* （予備）
            container: 'div:has(div > div > div > div > div > button > div > svg path[d^="M21.869 16h-3.5c-.77"])',
            footer: 'button:has(svg path[d^="M21.869 16h-3.5c-.77"])',
        }, ],

        // URL制御用セクレタ配列（shouldExecuteで使用）
        whitelistPaths: [
            '/app*', '/gem*', '/u/*/app*', '/u/*/gem*', '/c', '/c/*', '/g/*', '/search?*udm=50*', '/i/grok*',
        ],
        blacklistPaths: [
            '/saved-info', '/apps', '/sharing', '/gems/*', '/settings',
            '/u/*/saved-info', '/u/*/apps', '/u/*/sharing', '/u/*/gems/*', '/u/*/settings',
            '/faq', '/privacy', '/terms',
        ],

        // DOM除去用セクレタ配列（responseAnswerTextで使用）
        selectorsToRemove: [
            '#convertButtonWrapper',
            '.extension-processing-state',
            '.attachment-container',
            '.hide-from-message-actions',
            '.cdk-visually-hidden',
            '.gpi-static-text-loader',
            '.avatar-gutter',
            '.legacy-sources-sidebar-button',
            '.thoughts-header',
            '.bot-name', '.sr-only',
            '.tool-summary','user-notice',
            'pre', 'code-block', 'mat-paginator', 'immersive-entry-chip', 'inline-location',
            'model-thoughts', 'deletion-candidate-memories-response-block',
            'div[style*="display: none"]', 'div[role="status"]', 'span.cgpt-timestamp',
            'div[role="link"]', 'button', '.action-buttons', '.text-secondary',
            'div[jscontroller="a5f0he"]', // Google検索AIモードのボタン群 (役になった/役に立たない)
        ],

        // 処理中断用セクレタ配列（responseAnswerTextで使用）
        selectorsToInterrupt: [
            '.processing-state',      // 応答生成中（例：「思考中」）
            '.stopped-draft-message', // 応答生成が停止された場合
        ],

        // テキスト内容を「置換」する正規表現と置換後の文字のペア
        // AIの表記揺れ（無音、無音区間、秒、全角半角、スペース）を吸収してシステム統一タグにするわ！
        textsToReplaceRegex: [ {
            // マッチ条件：カッコに囲まれた「無音（区間）〇秒」のあらゆる表記揺れ
            // 対象例：【無音（２秒）】、(5秒間の無音)、（無音 3.5秒）、(無音: 2)、[silent: 6.0]
            pattern: "[【（\\[\\(][\\s\\u3000]*(?:(?:(?:無音(?:区間)?|silent)[：:\\s\\u3000]*[（\\[\\(]?[\\s\\u3000]*([\\d０-９]+(?:[.\\uff0e][\\d０-９]+)?)[\\s\\u3000]*(?:秒|sec)?)[】）\\]\\)]*|[（\\[\\(]?[\\s\\u3000]*([\\d０-９]+(?:[.\\uff0e][\\d０-９]+)?)[\\s\\u3000]*(?:秒|sec)?(?:間の)?[\\s\\u3000]*無音)[\\s\\u3000]*[】）\\]\\)]*",
            replacement: function(match, p1, p2) {
                // マッチした方の数字（全角かもしれない）を取得
                let numStr = p1 || p2;

                // 【超重要】全角数字（３）を半角数字（3）に変換する処理
                numStr = numStr.replace(/[０-９]/g, function(s) {
                    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
                }).replace(/\\uff0e/g, '.'); // 全角ドットも半角に

                return `[pause:${numStr}]`; // 置換後：システムで判別しやすい独自の形にする（$1 には抜き出した数字が入るわ）
            },
        }, ],

        // テキスト内容で除去する定型文/NGワードの配列（responseAnswerTextで使用）
        // これらの文字列は、抽出されたテキスト全体から除去されるわ
        // 除去したい単語や定型文を文字列で追加してね。正規表現として解釈されるわ！
        textsToRemoveRegex: [
            // 日本語版（アプリ アクティビティ）
            "なお、各種アプリのすべての機能を使用するには、Gemini アプリ アクティビティを有効にする必要があります[。\\s\\.\\:]*",
            // 英語版（Apps Activity notification）
            "Note:\\s?To use all features of the apps?,\\s?you need to enable the Gemini Apps Activity[\\s\\.\\:]*",
            "By the way,?\\s+to unlock the full functionality of all Apps,?\\s+enable Gemini Apps Activity[\\s\\.\\:]*",

            /* 💡 NGワード機能として使う例: "今日は", // 「おはよう、今日は晴れです」 -> 「おはよう、晴れです」
            *** 正規表現 ***
            ** 1. 最初の「それでは」より前、ワードを対象に含めない, 対象に含める
            * > "^[\\s\\S]*?(?=それでは)", "^[\\s\\S]*?それでは",
            ** 2. 最後の「ここまで」より前、ワードを対象に含めない, 対象に含める
            * > "^[\\s\\S]*(?=ここまで)", "^[\\s\\S]*ここまで",
            ** 3. 最初の「おつかれ」から最後まで、ワードを対象に含めない, 対象に含める
            * > "(?<=おつかれ)[\\s\\S]*$", "おつかれ[\\s\\S]*$",
            ** 4. 最後の「つづくよ」から最後まで、ワードを対象に含めない, 対象に含める
            * > "(?<=つづくよ)(?![\\s\\S]*つづくよ)[\\s\\S]*$", "つづくよ(?![\\s\\S]*つづくよ)[\\s\\S]*$",
            ** 5. 最初の「ここから」より前と最後の「そこまで」から最後まで、ワードを対象に含めない, 対象に含める
            * > "^[\\s\\S]*?(?=ここから)|(?<=そこまで)(?![\\s\\S]*そこまで)[\\s\\S]*$",
            * > "^[\\s\\S]*?ここから|そこまで(?![\\s\\S]*そこまで)[\\s\\S]*$",
            ** 6. 全角「（）」, 「【】」の中身だけを消す（カッコ自体は別の処理で消えるわ）
            * > "(?<=（)[^（）\\(\\)\\[\\]【】]+(?=）)", "(?<=【)[^（）\\(\\)\\[\\]【】]+(?=】)",
            ***/
        ],
    };
    let savedConfig = GM_getValue(STORE_KEY, {});
    let config = {
        ...DEFAULT_CONFIG,
        ...savedConfig,
    };

    const DEBUG = false;           // デバッグログ出力フラグ (開発用)
    const DEBUG_BUTTON = false;    // ボタン更新のデバッグログ出力フラグ (開発用)
    const DEBUG_REGEX = false;     // NGワード除去前後のデバッグログ出力フラグ (開発用)
    let DEBUG_TEXT = '';           // NGワード除去前後のデバッグログ用テキスト (開発用)
    const DEBUG_DETECTION = false; // DOM検出のデバッグログ出力フラグ (開発用)

    let menuIds = {
        settings: null,
        rvc: null,
        download: null,
        cache: null,
    };

    // アイコン
    const ICON_DEFINITIONS = {
        // ① 絵文字モード（軽量・標準）
        emoji: {
            type: 'text',
            stop: '🔇', wait: '🐾', sync: '⏳', play: '🔊', save:'💾',
        },
        // ② Font Awesome（SVGの「見た目（path）」のデータだけを内蔵）
        awesome: {
            type: 'svg',
            viewBox: '0 0 640 640',
            stop: 'M73 39C63.6 29.7 48.4 29.7 39 39C29.6 48.3 29.7 63.6 39 73L567 601C576.4 610.4 591.6 610.4 600.9 601C610.2 591.6 610.3 576.4 600.9 567.1L504.3 470.5C548.7 427.3 575.9 368.7 575.9 304C575.9 171.5 461.3 64 319.9 64C256.9 64 199.1 85.4 154.5 120.8L73 39zM92.4 194C74.2 227 64 264.3 64 303.9C64 358.2 83.2 408.2 115.6 448.4L66.8 540.7C62 549.7 63.5 560.7 70.4 568.2C77.3 575.7 88.1 578 97.5 574L215.9 523.3C247.7 536.6 283 544 320 544C356.4 544 390.9 536.9 422.3 524.1L92.3 194.1z', // d属性の中身だけ！
            wait: 'M298.5 156.9C312.8 199.8 298.2 243.1 265.9 253.7C233.6 264.3 195.8 238.1 181.5 195.2C167.2 152.3 181.8 109 214.1 98.4C246.4 87.8 284.2 114 298.5 156.9zM164.4 262.6C183.3 295 178.7 332.7 154.2 346.7C129.7 360.7 94.5 345.8 75.7 313.4C56.9 281 61.4 243.3 85.9 229.3C110.4 215.3 145.6 230.2 164.4 262.6zM133.2 465.2C185.6 323.9 278.7 288 320 288C361.3 288 454.4 323.9 506.8 465.2C510.4 474.9 512 485.3 512 495.7L512 497.3C512 523.1 491.1 544 465.3 544C453.8 544 442.4 542.6 431.3 539.8L343.3 517.8C328 514 312 514 296.7 517.8L208.7 539.8C197.6 542.6 186.2 544 174.7 544C148.9 544 128 523.1 128 497.3L128 495.7C128 485.3 129.6 474.9 133.2 465.2zM485.8 346.7C461.3 332.7 456.7 295 475.6 262.6C494.5 230.2 529.6 215.3 554.1 229.3C578.6 243.3 583.2 281 564.3 313.4C545.4 345.8 510.3 360.7 485.8 346.7zM374.1 253.7C341.8 243.1 327.2 199.8 341.5 156.9C355.8 114 393.6 87.8 425.9 98.4C458.2 109 472.8 152.3 458.5 195.2C444.2 238.1 406.4 264.3 374.1 253.7z',
            sync: 'M160 64C142.3 64 128 78.3 128 96C128 113.7 142.3 128 160 128L160 139C160 181.4 176.9 222.1 206.9 252.1L274.8 320L206.9 387.9C176.9 417.9 160 458.6 160 501L160 512C142.3 512 128 526.3 128 544C128 561.7 142.3 576 160 576L480 576C497.7 576 512 561.7 512 544C512 526.3 497.7 512 480 512L480 501C480 458.6 463.1 417.9 433.1 387.9L365.2 320L433.1 252.1C463.1 222.1 480 181.4 480 139L480 128C497.7 128 512 113.7 512 96C512 78.3 497.7 64 480 64L160 64zM224 139L224 128L416 128L416 139C416 158 410.4 176.4 400 192L240 192C229.7 176.4 224 158 224 139zM240 448C243.5 442.7 247.6 437.7 252.1 433.1L320 365.2L387.9 433.1C392.5 437.7 396.5 442.7 400.1 448L240 448z',
            play: 'M320 544C461.4 544 576 436.5 576 304C576 171.5 461.4 64 320 64C178.6 64 64 171.5 64 304C64 358.3 83.2 408.3 115.6 448.5L66.8 540.8C62 549.8 63.5 560.8 70.4 568.3C77.3 575.8 88.2 578.1 97.5 574.1L215.9 523.4C247.7 536.6 282.9 544 320 544zM192 272C209.7 272 224 286.3 224 304C224 321.7 209.7 336 192 336C174.3 336 160 321.7 160 304C160 286.3 174.3 272 192 272zM320 272C337.7 272 352 286.3 352 304C352 321.7 337.7 336 320 336C302.3 336 288 321.7 288 304C288 286.3 302.3 272 320 272zM416 304C416 286.3 430.3 272 448 272C465.7 272 480 286.3 480 304C480 321.7 465.7 336 448 336C430.3 336 416 321.7 416 304z',
            save: 'M352 96C352 78.3 337.7 64 320 64C302.3 64 288 78.3 288 96L288 306.7L246.6 265.3C234.1 252.8 213.8 252.8 201.3 265.3C188.8 277.8 188.8 298.1 201.3 310.6L297.3 406.6C309.8 419.1 330.1 419.1 342.6 406.6L438.6 310.6C451.1 298.1 451.1 277.8 438.6 265.3C426.1 252.8 405.8 252.8 393.3 265.3L352 306.7L352 96zM160 384C124.7 384 96 412.7 96 448L96 480C96 515.3 124.7 544 160 544L480 544C515.3 544 544 515.3 544 480L544 448C544 412.7 515.3 384 480 384L433.1 384L376.5 440.6C345.3 471.8 294.6 471.8 263.4 440.6L206.9 384L160 384zM464 440C477.3 440 488 450.7 488 464C488 477.3 477.3 488 464 488C450.7 488 440 477.3 440 464C440 450.7 450.7 440 464 440z',
        },
        // ③ Google Material Symbols（d属性の中身だけ）
        google: {
            type: 'svg',
            viewBox: '0 -960 960 960',
            stop: 'M248.5-528.5Q240-537 240-550v-20q0-13 8.5-21.5T270-600q13 0 21.5 8.5T300-570v20q0 13-8.5 21.5T270-520q-13 0-21.5-8.5Zm420 0Q660-537 660-550v-20q0-13 8.5-21.5T690-600q13 0 21.5 8.5T720-570v20q0 13-8.5 21.5T690-520q-13 0-21.5-8.5ZM340-470v-150l60 60v90q0 13-8.5 21.5T370-440q-13 0-21.5-8.5T340-470Zm110 80v-120l60 60v60q0 13-8.5 21.5T480-360q-13 0-21.5-8.5T450-390Zm51.5-361.5Q510-743 510-730v94q0 15-9.5 22t-20.5 7q-11 0-20.5-7.5T450-636v-94q0-13 8.5-21.5T480-760q13 0 21.5 8.5Zm110 80Q620-663 620-650v124q0 15-9.5 22t-20.5 7q-11 0-20.5-7.5T560-526v-124q0-13 8.5-21.5T590-680q13 0 21.5 8.5ZM880-800v498q0 17-11.5 28.5T840-262q-15 0-27.5-10T800-302v-498H291q-20 0-30-12.5T251-840q0-15 10-27.5t30-12.5h509q33 0 56.5 23.5T880-800ZM240-240l-92 92q-19 19-43.5 8.5T80-177v-591l-24-24q-11-11-11-28t11-28q11-11 28-11t28 11l736 736q11 11 11.5 27.5T848-56q-11 11-28 11t-28-11L606-240H240Zm297-297Zm-193 33ZM160-688v413l46-45h322L160-688Z',
            wait: 'M180-475q-42 0-71-29t-29-71q0-42 29-71t71-29q42 0 71 29t29 71q0 42-29 71t-71 29Zm109-189q-29-29-29-71t29-71q29-29 71-29t71 29q29 29 29 71t-29 71q-29 29-71 29t-71-29Zm240 0q-29-29-29-71t29-71q29-29 71-29t71 29q29 29 29 71t-29 71q-29 29-71 29t-71-29Zm251 189q-42 0-71-29t-29-71q0-42 29-71t71-29q42 0 71 29t29 71q0 42-29 71t-71 29ZM266-75q-45 0-75.5-34.5T160-191q0-52 35.5-91t70.5-77q29-31 50-67.5t50-68.5q22-26 51-43t63-17q34 0 63 16t51 42q28 32 49.5 69t50.5 69q35 38 70.5 77t35.5 91q0 47-30.5 81.5T694-75q-54 0-107-9t-107-9q-54 0-107 9t-107 9Z',
            sync: 'M320-160h320v-120q0-66-47-113t-113-47q-66 0-113 47t-47 113v120Zm273-407q47-47 47-113v-120H320v120q0 66 47 113t113 47q66 0 113-47ZM160-80v-80h80v-120q0-61 28.5-114.5T348-480q-51-32-79.5-85.5T240-680v-120h-80v-80h640v80h-80v120q0 61-28.5 114.5T612-480q51 32 79.5 85.5T720-280v120h80v80H160Zm320-80Zm0-640Z',
            play: 'M291.5-528.5Q300-537 300-550v-20q0-13-8.5-21.5T270-600q-13 0-21.5 8.5T240-570v20q0 13 8.5 21.5T270-520q13 0 21.5-8.5Zm100 80Q400-457 400-470v-180q0-13-8.5-21.5T370-680q-13 0-21.5 8.5T340-650v180q0 13 8.5 21.5T370-440q13 0 21.5-8.5Zm110 80Q510-377 510-390v-340q0-13-8.5-21.5T480-760q-13 0-21.5 8.5T450-730v340q0 13 8.5 21.5T480-360q13 0 21.5-8.5Zm110-80Q620-457 620-470v-180q0-13-8.5-21.5T590-680q-13 0-21.5 8.5T560-650v180q0 13 8.5 21.5T590-440q13 0 21.5-8.5Zm100-80Q720-537 720-550v-20q0-13-8.5-21.5T690-600q-13 0-21.5 8.5T660-570v20q0 13 8.5 21.5T690-520q13 0 21.5-8.5ZM240-240l-92 92q-19 19-43.5 8.5T80-177v-623q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240Zm-34-80h594v-480H160v525l46-45Zm-46 0v-480 480Z',
            save: 'M840-680v480q0 33-23.5 56.5T760-120H200q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h480l160 160Zm-80 34L646-760H200v560h560v-446ZM565-275q35-35 35-85t-35-85q-35-35-85-35t-85 35q-35 35-35 85t35 85q35 35 85 35t85-35ZM240-560h360v-160H240v160Zm-40-86v446-560 114Z',
        },
    };

    // スタイル定義（GM_addStyle）
    GM_addStyle(`
        /* Font Awesome 6 Free */
        /* @import url('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'); */
        /* Google Material Symbols & Icons (Rounded) */
        /* @import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200'); */

        #mei-settings-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.7);
            z-index: 99999;
        }
        #mei-settings-panel {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background-color: #333; /* Dark background */
            padding: 25px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            width: 90%;
            max-width: 560px;
            color: #e8eaed; /* Light text */
        }
        .mei-input-field {
            width: 100%;
            padding: 8px 10px;
            margin-top: 5px;
            border: 1px solid #5f6368;
            border-radius: 4px;
            box-sizing: border-box;
            background-color: #202124; /* Darker input background */
            color: #e8eaed;
            font-size: 14px;
        }
        .mei-input-field:focus {
            border-color: #8ab4f8;
            outline: none;
        }
        /* Chrome, Safari, Edge 用 */
        .mei-input-field::-webkit-outer-spin-button,
        .mei-input-field::-webkit-inner-spin-button {
            margin-left: 4px; /* ここで数字との距離を調整できるわよ！ */
        }
        .mei-button-primary {
            padding: 8px 15px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            background-color: #8ab4f8; /* Blue button */
            color: #202124;
        }
        .mei-button-secondary {
            padding: 8px 15px;
            border: 1px solid #5f6368;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            background-color: #333;
            color: #e8eaed;
        }
        .material-symbols-rounded {
            font-size: 22px;
            line-height: 1;          /* アイコンの上下余白を減らし、中央揃えを改善します */
        }
        #convertButtonWrapper {
            display: flex;           /* Flexboxコンテナにする */
            align-self: center;      /* 親のFlexコンテナ内で自身を中央に配置 */
            height: 28px;
            align-items: center;     /* 垂直方向 */
            justify-content: center; /* 水平方向 */
        }
        #convertButtonIcon {
            display: inline-flex;
            font-size: 18px;
            margin-right: 6px;
        }
        #convertButton {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2px 4px;
            border: none;
            border-radius: 16px;
            color: white;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
            width: auto;
            min-width: 108px;
            height: 100%;
            transition: transform 0.2s, background-color 0.2s;
        }
        #downloadButton {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2px 4px;
            border: none;
            border-radius: 50%;
            color: white;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
            margin-left: 8px;
            width: 28px;
            height: 100%;
            transition: transform 0.2s, background-color 0.2s;
        }
        #downloadButtonIcon {
            display: inline-flex;
            font-size: 18px;
        }
        #convertButton:hover, #downloadButton:not([disabled]):hover {
            transform: scale(1.05);
        }
        #downloadButton[disabled] {
            background-color: #6c757d !important; /* disabled:bg-gray-500 の代替 */
            color: #bdbdbd !important;            /* disabled:text-gray-300 の代替 */
            cursor: not-allowed !important;       /* disabled:cursor-not-allowed の代替 */
            transform: scale(1.0);                /* 無効時はアニメーションしない */
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    `);

    // ========= トーストメッセージ =========
    function showToast(msg, isSuccess) {
        const toastId = 'spitch-toast';
        console.log(`[TOAST] ${msg}`);

        if (toastTimeoutId) {
            clearTimeout(toastTimeoutId);
            toastTimeoutId = null;
        }

        // 20ms遅延させて、重いDOM操作中のレンダリング競合を回避
        setTimeout(() => {
            const existingToast = document.getElementById(toastId);
            if (existingToast) {
                existingToast.remove();
            }

            const toast = document.createElement('div');
            toast.textContent = msg;
            toast.id = toastId;
            toast.classList.add('spitch-toast');

            let bgColor;
            if (isSuccess === true) {
                bgColor = '#007bff';
            } else if (isSuccess === false) {
                bgColor = '#dc3545';
            } else {
                bgColor = '#6c757d';
            }

            toast.style.cssText = `
                position: fixed; bottom: 0px; left: 50%; transform: translateX(-50%);
                background: ${bgColor}; color: white; padding: 4px 20px;
                border-radius: 14px; z-index: 100000;
                height: 24px;
                font-size: 14px; transition: opacity 1.0s ease, transform 1.0s ease; opacity: 0;
            `;
            toast.style.display = 'flex';          // Flexbox有効化
            toast.style.alignItems = 'center';     // 垂直方向の中央揃え
            toast.style.justifyContent = 'center'; // 水平方向の中央揃え
            document.body.appendChild(toast);

            // フェードインアニメーションを起動
            setTimeout(() => {
                toast.style.opacity = '1';
                toast.style.transform = 'translate(-50%, -16px)';
            }, 10);

            // 自動非表示ロジック
            if (isSuccess !== null) {
                toastTimeoutId = setTimeout(() => {
                    toast.style.opacity = '0';
                    toast.style.transform = 'translate(-50%, 0)';
                    setTimeout(() => {
                        if (document.body.contains(toast)) {
                            toast.remove();
                        }
                        if (toastTimeoutId) {
                            toastTimeoutId = null;
                        }
                    }, 1000);
                }, 3000);
            }
        }, 20);
    }

    function getFormattedDateTime() {
        const now = new Date();

        const pad = (num) => num.toString().padStart(2, '0'); // ２桁にする関数

        const y = now.getFullYear();
        const m = pad(now.getMonth() + 1);
        const d = pad(now.getDate());
        const h = pad(now.getHours());
        const min = pad(now.getMinutes());
        const s = pad(now.getSeconds());

        return `${y}/${m}/${d} ${h}:${min}:${s}`;
    }

    // --- 🪄 マジック・リンク同期エンジン ---
    (function handleMagicLinkSync() {
        const hash = window.location.hash;
        if (!hash.startsWith('#sync_v_')) {
            return;
        }

        try {
            // #sync_v_ 以降を取り出してデコード
            const encodedData = hash.substring(8);
            const decodedData = decodeURIComponent(atob(encodedData));
            const params = JSON.parse(decodedData);

            // params = { vv: "URL", rvc: "URL", ts: 123456789 } みたいな構造を想定
            let updated = false;

            // 1. 設定の更新: config にある項目なら保存する
            for (const key in params) {
                // 1. configにある項目なら、設定として上書き
                if (key in config) {
                    config[key] = params[key];
                    updated = true;
                } else {
                    // 2. configにない項目（一時パッチなど）
                }
            }

            if (updated) {
                GM_setValue(STORE_KEY, config);
            }

            // 動的パッチ: 今のリストを壊さず、追加・修正する

            // --- selectorsResponse のマージロジック ---
            if (params.selectors) {
                params.selectors.forEach(newSite => {
                    // 既存のリストから、同じコンテナ名（または識別子）を持つものを探す
                    const index = config.selectorsResponse.findIndex(s => s.container === newSite.container);

                    if (index !== -1) {
                        config.selectorsResponse[index] = newSite; // 既存を更新
                    } else {
                        config.selectorsResponse.unshift(newSite); // 先頭に追加
                    }
                });
            }

            // 一時的な微調整
            if (params.debounce) {
                config.debounceDelay = params.debounce;
            }

            // --- 文字列置換をまるごと入れ替え ---
            if (params.ngword) {
                config.textsToReplaceRegex = params.replace;
            }

            // --- NGワードをまるごと入れ替え ---
            if (params.ngword) {
                config.textsToRemoveRegex = params.ngword;
            }

            // --- 保存した設定を削除して初期値に戻す ---
            if (params.reset) {
                GM_deleteValue(STORE_KEY);
            }

            // URLを綺麗にする
            window.history.replaceState(null, null, window.location.origin + window.location.pathname + window.location.search);

            if (params.reset) {
                showToast('🧹 設定を初期化したわ！初期値で再起動するわね。', true);
                setTimeout(() => window.location.reload(), 1200);
            } else if (updated || params.selectors || params.debounce || params.ngword) {
                showToast('✨ マジック・リンクを適用したわ！', true);
            }
        } catch (e) {
            console.error('同期失敗:', e);
            showToast('⚠️ パッチの適用に失敗したみたい', false);
        }
    })();

    // ========= VOICEVOX連携 設定UI =========
    function openSettings() {
        if (document.getElementById('mei-settings-overlay')) {
            return;
        }
        refreshMenuCommands();

        // --- 一時パッチの衝突ガード ---
        const currentSaved = GM_getValue(STORE_KEY, {});
        let isTemporaryPatched = false;

        // メモリ上の config と、本来ストレージにある設定を比較する
        for (const key in config) {
            // 例外処理：selectorsResponseなどの配列やオブジェクトは簡易比較。基本はプリミティブ値の比較
            if (typeof config[key] === 'object' && config[key] !== null) {
                // 配列やオブジェクトの場合、JSON文字列にして簡易比較
                if (JSON.stringify(config[key]) !== JSON.stringify(currentSaved[key] !== undefined ? currentSaved[key] : DEFAULT_CONFIG[key])) {
                    isTemporaryPatched = true;
                    break;
                }
            } else {
                // 通常の数値、文字列、真偽値の比較
                // ストレージにないキーなら DEFAULT_CONFIG の値を正とする
                const savedValue = currentSaved[key] !== undefined ? currentSaved[key] : DEFAULT_CONFIG[key];
                if (config[key] !== savedValue) {
                    isTemporaryPatched = true;
                    break;
                }
            }
        }

        // 一時変更が検知された場合、ユーザーに確認をとる
        if (isTemporaryPatched) {
            const proceed = confirm(
                "🪄 現在、マジック・リンクによる一時的な設定が適用されているわ。\n\n" +
                "一時変更の効果は消えて元の保存設定に上書きされるけれど、設定画面を開いてもいいかしら？"
            );

            if (!proceed) {
                return; // キャンセルされたら、設定画面を開かずに終了！
            }

            // ユーザーが「OK」した場合は、メモリ上の config を「本来保存されているデータ」で上書き復元する！
            // これにより、UIの入力欄にはマジック・リンクに汚されていない元の設定値が表示されるわ。
            config = {
                ...DEFAULT_CONFIG,
                ...currentSaved,
            };
        }

        // OVERLAY（トップコンテナ）
        const overlay = document.createElement('div');
        overlay.id = 'mei-settings-overlay';
        overlay.style.cssText = 'display: flex; justify-content: center; align-items: center;';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                document.removeEventListener('keydown', escListener); // ESCリスナーも削除
            }
        });

        // ESCキーで閉じる
        const escListener = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                overlay.remove();
                document.removeEventListener('keydown', escListener);
            }
        };
        document.addEventListener('keydown', escListener);

        // PANEL（設定パネル本体）
        const panel = document.createElement('div');
        panel.id = 'mei-settings-panel';

        // TITLE（タイトル）
        const titleH2 = document.createElement('h2');
        titleH2.textContent = `🔊 VOICEVOX連携 設定 (v${SCRIPT_VERSION})`;
        titleH2.style.cssText = 'margin-top: 0; margin-bottom: 20px; font-size: 1.5em; color: #e8eaed;';
        panel.appendChild(titleH2);
        panel.addEventListener('click', (e) => {
            // パネル内でのクリックイベントの伝播をここで完全に停止させる
            e.stopPropagation();
        });

        // SPEAKER ID GROUP
        const speakerGroup = document.createElement('div');
        speakerGroup.style.marginBottom = '20px';

        const speakerSelectorContainer = document.createElement('div');
        speakerSelectorContainer.style.cssText = 'display: flex; align-items: center; justify-content: space-between;'; // インナーコンテナ： space-between で両端に振り分けるわ

        const speakerLabel = document.createElement('label');
        speakerLabel.textContent = 'VOICEVOX 読み上げ話者:';
        speakerLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; white-space: nowrap; margin-right: 20px;'; // 右側に少し余白（最小値）を持たせておくわ
        speakerSelectorContainer.appendChild(speakerLabel);

        setupSpeakerSelector(speakerSelectorContainer, config.speakerId, config.apiUrl); // セレクトボックスを設置

        speakerGroup.appendChild(speakerSelectorContainer);

        // ヘルプテキスト
        const speakerHelp = document.createElement('p');
        speakerHelp.textContent = '* VOICEVOXが起動していないとリストは更新されないわよ！';
        speakerHelp.style.cssText = 'margin-top: 8px; font-size: 0.8em; color: #9aa0a6; text-align: left;';
        speakerGroup.appendChild(speakerHelp);

        panel.appendChild(speakerGroup);

        // サンプル再生ボタン
        const sampleGroup = document.createElement('div');
        sampleGroup.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-top: 5px; border-top: 1px solid #444;';

        const sampleText = document.createElement('p');
        sampleText.textContent = '👆この声で合っているかテストよ！';
        sampleText.style.cssText = 'margin: 0; font-size: 0.9em; color: #e8eaed;';
        sampleGroup.appendChild(sampleText);

        const sampleBtn = document.createElement('button');
        sampleBtn.id = 'mei-sample-play-btn';
        sampleBtn.textContent = '🔊 サンプル再生';
        sampleBtn.style.cssText = 'display: flex; justify-content: center; align-items: center; height: 32px; width: 128px; line-height: 1; color: white; background: #5cb85c; font-weight: bold; border: none; border-radius: 16px; cursor: pointer;';
        sampleBtn.onclick = () => startSampleConversion();
        sampleGroup.appendChild(sampleBtn);
        panel.appendChild(sampleGroup);

        // API URL GROUP
        const apiGroup = document.createElement('div');
        apiGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 20px;';

        const apiLabel = document.createElement('label');
        apiLabel.textContent = 'VOICEVOX API URL:';
        apiLabel.setAttribute('for', 'apiUrl');
        apiLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; margin-right: 15px; flex-shrink: 0;';
        apiGroup.appendChild(apiLabel);

        const apiInput = document.createElement('input');
        apiInput.type = 'url';
        apiInput.id = 'apiUrl';
        apiInput.value = config.apiUrl;
        apiInput.style.cssText = 'flex-grow: 1; min-width: 0;'; // min-width: 0 は幅が突き抜けないためのおまじない
        apiInput.classList.add('mei-input-field');
        apiGroup.appendChild(apiInput);

        const apiRefreshBtn = document.createElement('button');
        apiRefreshBtn.textContent = '🔄 更新';

        // style.cssText の中に margin-left を含めつつ、!important を使わずに「flex-shrink: 0」で潰されないようにするわ
        apiRefreshBtn.style.cssText = `
            margin-left: 12px !important;
            padding: 0 12px;
            height: 32px;
            background: #4a4a4a;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            white-space: nowrap;
            font-size: 0.85em;
            flex-shrink: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        `;
        apiRefreshBtn.onclick = () => {
            const tempUrl = apiInput.value.trim();
            if (!tempUrl) {
                showToast('URLを入力してね！', false);
                return;
            }
            // リスト取得関数を呼び出す（現在のセレクトボックスを再利用）
            setupSpeakerSelector(speakerSelectorContainer, config.speakerId, tempUrl);
        };
        apiGroup.appendChild(apiRefreshBtn);

        panel.appendChild(apiGroup);

        // 自動再生 ON/OFF トグル
        const autoPlayGroup = document.createElement('div');
        autoPlayGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 20px;';

        const autoPlayInput = document.createElement('input');
        autoPlayInput.type = 'checkbox';
        autoPlayInput.id = 'autoPlay';
        autoPlayInput.checked = config.autoPlay;
        autoPlayInput.style.cssText = 'width: 20px; height: 20px; margin-right: 10px; flex-shrink: 0;';
        autoPlayGroup.appendChild(autoPlayInput);

        const autoPlayLabel = document.createElement('label');
        autoPlayLabel.textContent = '自動再生を有効にする (Geminiが回答完了したら自動再生)';
        autoPlayLabel.setAttribute('for', 'autoPlay');
        autoPlayLabel.style.cssText = 'font-weight: bold; color: #e8eaed; cursor: pointer;';
        autoPlayGroup.appendChild(autoPlayLabel);
        panel.appendChild(autoPlayGroup);

        // 最小読み上げ文字数 GROUP（minTextLength）
        const minLengthGroup = document.createElement('div');
        minLengthGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 5px;';

        const minLengthLabel = document.createElement('label');
        minLengthLabel.textContent = '最小読み上げ文字数 (1～10,000) [10]:';
        minLengthLabel.setAttribute('for', 'minTextLength');
        minLengthLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; margin-right: 15px; flex-shrink: 0;';
        minLengthGroup.appendChild(minLengthLabel);

        const minLengthInput = document.createElement('input');
        minLengthInput.type = 'number';
        minLengthInput.id = 'minTextLength';
        minLengthInput.value = config.minTextLength; // 設定ファイルから値を取得
        minLengthInput.min = '1';
        minLengthInput.max = '10000';
        minLengthInput.step = '1';
        minLengthInput.classList.add('mei-input-field');
        minLengthInput.style.cssText = 'width: 80px; flex-grow: 0; text-align: right;'; // 幅を固定
        minLengthGroup.appendChild(minLengthInput);
        panel.appendChild(minLengthGroup);

        const minLengthHelp = document.createElement('p');
        minLengthHelp.textContent = '*この文字数以下の短い回答や待機メッセージは自動再生されないわ！';
        minLengthHelp.style.cssText = 'margin-top: 5px; margin-bottom: 20px; font-size: 0.8em; color: #9aa0a6;';
        panel.appendChild(minLengthHelp);

        // 最大読み上げ文字数 GROUP（maxTextLength）
        const maxChunksGroup = document.createElement('div');
        maxChunksGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 5px;';

        const maxChunksLabel = document.createElement('label');
        maxChunksLabel.textContent = '最大分割数 (10～1,000) [100]:';
        maxChunksLabel.setAttribute('for', 'maxChunks');
        maxChunksLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; margin-right: 15px; flex-shrink: 0;';
        maxChunksGroup.appendChild(maxChunksLabel);

        const maxChunksInput = document.createElement('input');
        maxChunksInput.type = 'number';
        maxChunksInput.id = 'maxChunks';
        maxChunksInput.value = config.maxChunks; // 設定ファイルから値を取得
        maxChunksInput.min = '10';
        maxChunksInput.max = '1000';
        maxChunksInput.step = '1';
        maxChunksInput.classList.add('mei-input-field');
        maxChunksInput.style.cssText = 'width: 80px; flex-grow: 0; text-align: right;';
        maxChunksGroup.appendChild(maxChunksInput);
        panel.appendChild(maxChunksGroup);

        const maxChunksHelp = document.createElement('p');
        maxChunksHelp.textContent = `*この分割数を超えた部分はカットされるわ！（１分割は${DEFAULT_CHUNK_SIZE}文字）`;
        maxChunksHelp.style.cssText = 'margin-top: 5px; margin-bottom: 20px; font-size: 0.8em; color: #9aa0a6;';
        panel.appendChild(maxChunksHelp);

        // キー設定グループ
        const keyGroup = document.createElement('div');
        keyGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 5px;';

        const keyLabel = document.createElement('label');
        keyLabel.textContent = '再生/停止 ショートカットキー:';
        keyLabel.setAttribute('for', 'shortcutKey');
        keyLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; margin-right: 15px; flex-shrink: 0;';
        keyGroup.appendChild(keyLabel);

        const keyInput = document.createElement('input');
        keyInput.type = 'text';
        keyInput.id = 'shortcutKey';
        keyInput.value = config.shortcutKey;
        keyInput.classList.add('mei-input-field');
        keyInput.style.cssText = 'width: 160px; flex-grow: 0; cursor: pointer;'; // 幅を固定
        keyInput.readOnly = true;
        keyGroup.appendChild(keyInput);
        panel.appendChild(keyGroup);

        const keyHelp = document.createElement('p');
        keyHelp.textContent = '*クリックしてから「Ctrl+Shift+V」などのキーを押して設定してね！';
        keyHelp.style.cssText = 'margin-top: 5px; margin-bottom: 20px; font-size: 0.8em; color: #9aa0a6;';
        panel.appendChild(keyHelp);

        // キー録音ロジック
        let isRecording = false;

        keyInput.addEventListener('click', () => {
            if (isRecording) {
                isRecording = false;
                keyInput.style.backgroundColor = '';
                if (keyInput.value.includes('...')) {
                    keyInput.value = config.shortcutKey; // 途中でやめたら元の値に戻す
                }
                return;
            }

            isRecording = true;
            keyInput.value = 'キーを押してください...';
            keyInput.style.backgroundColor = '#3c4043';
        });

        const recordKey = (e) => {
            if (!isRecording) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();

            const isControl = e.ctrlKey || e.metaKey; // CommandキーもControlとして扱う
            const isAlt = e.altKey;
            const isShift = e.shiftKey;

            // ファンクションキー, Alt, Ctrl, Shift単体は許可しない
            if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key.startsWith('F')) {
                keyInput.value = '単体キーはダメよ！組み合わせてね。';
                return;
            }

            // IME入力中は処理しない
            if (e.isComposing || e.keyCode === 229) {
                return;
            }

            // Keyを大文字化
            let key = e.key;
            if (key.length === 1) {
                key = key.toUpperCase();
            } else if (key === ' ') {
                key = 'Space';
            }

            let shortcut = '';

            if (isControl) {
                shortcut += 'Ctrl+';
            }
            if (isAlt) {
                shortcut += 'Alt+';
            }
            if (isShift) {
                shortcut += 'Shift+';
            }

            // 組み合わせがない場合は、エラーを出す
            if (!isControl && !isAlt && !isShift) {
                keyInput.value = 'Ctrl, Alt, Shiftのどれかは必須よ！';
                return;
            }

            if (key !== 'Control' && key !== 'Shift' && key !== 'Alt' && key !== 'Meta') {
                shortcut += key;
            }

            if (shortcut.endsWith('+') || shortcut === '' || shortcut === 'Ctrl+' || shortcut === 'Alt+' || shortcut === 'Shift+') {
                keyInput.value = '有効なキーの組み合わせじゃないわ...';
                return;
            }

            // 成功
            keyInput.value = shortcut;
            keyInput.style.backgroundColor = '';
            isRecording = false;
        };

        keyInput.addEventListener('keydown', recordKey);
        panel.addEventListener('keydown', (e) => {
            // Spaceキーが押された場合にスクロールを防ぐ
            if (e.key === ' ' && isRecording) {
                e.preventDefault();
            }
        });

        // 最終フッターグループ: RVCボタン + 保存 + 閉じる
        const finalFooter = document.createElement('div');
        finalFooter.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-top: 20px;';

        const rvcSettingsBtn = document.createElement('button');
        rvcSettingsBtn.textContent = '🔊 RVC連携';
        rvcSettingsBtn.classList.add('mei-button', 'mei-button-secondary');
        rvcSettingsBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; margin-right: auto;';
        rvcSettingsBtn.addEventListener('click', () => {
            document.removeEventListener('keydown', escListener); // ESCリスナーを削除
            overlay.remove();  // VOICEVOX設定のオーバーレイを削除
            openRvcSettings(); // RVC設定を開く
        });

        // --- 右側の「保存」と「閉じる」をまとめるグループ ---
        const saveCloseGroup = document.createElement('div');
        saveCloseGroup.style.cssText = 'display: flex; gap: 10px;';

        const saveBtn = document.createElement('button');
        saveBtn.textContent = '保存';
        saveBtn.classList.add('mei-button', 'mei-button-primary');
        saveBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; width: 100px;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '閉じる';
        closeBtn.classList.add('mei-button', 'mei-button-secondary');
        closeBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; width: 100px;';
        closeBtn.onclick = () => {
            document.removeEventListener('keydown', escListener);
            overlay.remove();
        };

        // グループにボタンを追加
        saveCloseGroup.appendChild(saveBtn);
        saveCloseGroup.appendChild(closeBtn);

        // 最終フッターに左のボタンと右のグループを追加
        finalFooter.appendChild(rvcSettingsBtn);
        finalFooter.appendChild(saveCloseGroup);
        panel.appendChild(finalFooter);

        // DOMにパネルとオーバーレイを追加
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        saveBtn.addEventListener('click', () => {
            const newSpeakerId = parseInt(document.getElementById('speakerId').value, 10);
            const newApiUrl = apiInput.value.trim();
            const newAutoPlay = autoPlayInput.checked;
            const newShortcutKey = keyInput.value.trim();
            const minTextLengthInput = document.getElementById('minTextLength');
            const newMinTextLength = parseInt(minTextLengthInput.value, 10);
            const maxChunksInput = document.getElementById('maxChunks');
            const newMaxChunks = parseInt(maxChunksInput.value, 10);

            if (newShortcutKey === 'キーを押してください...' || newShortcutKey.includes('は必須よ！') || newShortcutKey.includes('じゃないわ...')) {
                showToast('ショートカットキーを正しく設定してね！', false);
                return;
            }
            if (isNaN(newMinTextLength) || newMinTextLength < 1 || newMinTextLength > 10000) {
                showToast('最小読み上げ文字数は半角数字で、1～10,000の範囲を入力してね！', false);
                return;
            }
            if (isNaN(newMaxChunks) || newMaxChunks < 10 || newMaxChunks > 1000) {
                showToast(`最大分割数は半角数字で、10～1,000の範囲を入力してね！`, false);
                return;
            }
            // 最小文字数が「最大チャンク数 × DEFAULT_CHUNK_SIZE(目安)」を明らかに超えている場合の警告
            if (newMinTextLength > (newMaxChunks * DEFAULT_CHUNK_SIZE)) {
                showToast('最小文字数が大きすぎて、設定された最大分割数では一生再生されないわよ！', false);
                return;
            }

            const currentUIValues = {
                speakerId: newSpeakerId,
                apiUrl: newApiUrl,
                autoPlay: newAutoPlay,
                minTextLength: newMinTextLength,
                maxChunks: newMaxChunks,
                shortcutKey: newShortcutKey,
            };
            saveModifiedConfigOnly(currentUIValues);

            showToast('設定を保存したわ！', true);
            document.removeEventListener('keydown', escListener);
            overlay.remove();
        });
    }

    // VOICEVOXの話者リストを取得して、セレクトボックスを構築・更新するわ
    async function setupSpeakerSelector(container, currentId, apiUrl) {
        // 既にセレクトボックスがあるかチェック、なければ作る
        let select = document.getElementById('speakerId');
        if (!select) {
            select = document.createElement('select');
            select.id = 'speakerId';
            select.classList.add('mei-input-field');
            select.style.cssText = 'width: 100%; max-width: 240px; margin-top: 5px;';
            container.appendChild(select);
        }

        // --- ここから取得ロジック ---
        // 取得中は今の値を保持したまま「取得中...」を表示
        select.textContent = '';
        const loadingOpt = document.createElement('option');
        loadingOpt.value = currentId;
        loadingOpt.textContent = `⏳ 取得中... (ID: ${currentId})`;
        loadingOpt.selected = true;
        select.appendChild(loadingOpt);

        const handleConnectionError = (type) => {
            const msg = type === 'timeout' ? 'タイムアウト' : '接続失敗';
            loadingOpt.textContent = `⚠️ ${msg} - ID: ${currentId}`;
            showToast(`${msg}よ。URLを確認してみて！`, false);
        };

        GM_xmlhttpRequest({
            method: 'GET',
            url: `${apiUrl}/speakers`,
            timeout: 5000,
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        const speakers = JSON.parse(response.responseText);
                        select.textContent = ''; // 成功したらクリアして作り直し

                        let foundCurrent = false;
                        speakers.forEach(speaker => {
                            speaker.styles.forEach(style => {
                                const option = document.createElement('option');
                                option.value = style.id;
                                option.textContent = `${speaker.name}（${style.name}）`;
                                if (style.id === parseInt(currentId, 10)) {
                                    option.selected = true;
                                    foundCurrent = true;
                                }
                                select.appendChild(option);
                            });
                        });

                        showToast('✅ 話者リストを更新したわ！', true);

                    } catch (e) {
                        loadingOpt.textContent = `⚠️ 解析失敗 - ID: ${currentId}`;
                        showToast('リストの解析に失敗しちゃった', false);
                    }
                } else {
                    loadingOpt.textContent = `⚠️ エラー(${response.status}) - ID: ${currentId}`;
                }
            },
            onerror: () => handleConnectionError('error'),
            ontimeout: () => handleConnectionError('timeout'),
        });
    }

    // ========= RVC連携 設定UI =========
    function openRvcSettings() {
        if (document.getElementById('mei-settings-overlay')) {
            return;
        }

        // --- 一時パッチの衝突ガード ---
        const currentSaved = GM_getValue(STORE_KEY, {});
        let isTemporaryPatched = false;

        // メモリ上の config と、本来ストレージにある設定を比較する
        for (const key in config) {
            // 例外処理：selectorsResponseなどの配列やオブジェクトは簡易比較。基本はプリミティブ値の比較
            if (typeof config[key] === 'object' && config[key] !== null) {
                // 配列やオブジェクトの場合、JSON文字列にして簡易比較
                if (JSON.stringify(config[key]) !== JSON.stringify(currentSaved[key] !== undefined ? currentSaved[key] : DEFAULT_CONFIG[key])) {
                    isTemporaryPatched = true;
                    break;
                }
            } else {
                // 通常の数値、文字列、真偽値の比較
                // ストレージにないキーなら DEFAULT_CONFIG の値を正とする
                const savedValue = currentSaved[key] !== undefined ? currentSaved[key] : DEFAULT_CONFIG[key];
                if (config[key] !== savedValue) {
                    isTemporaryPatched = true;
                    break;
                }
            }
        }

        // 一時変更が検知された場合、ユーザーに確認をとる
        if (isTemporaryPatched) {
            const proceed = confirm(
                "🪄 現在、マジック・リンクによる一時的な設定が適用されているわ。\n\n" +
                "一時変更の効果は消えて元の保存設定に上書きされるけれど、設定画面を開いてもいいかしら？"
            );

            if (!proceed) {
                return; // キャンセルされたら、設定画面を開かずに終了！
            }

            // ユーザーが「OK」した場合は、メモリ上の config を「本来保存されているデータ」で上書き復元する！
            // これにより、UIの入力欄にはマジック・リンクに汚されていない元の設定値が表示されるわ。
            config = {
                ...DEFAULT_CONFIG,
                ...currentSaved,
            };
        }

        const oldRvcModel = config.rvcModel;
        const oldRvcEnabled = config.rvcEnabled;

        // --- オーバーレイとパネルの基本設定 ---
        const overlay = document.createElement('div');
        overlay.id = 'mei-settings-overlay';
        overlay.style.cssText = 'display: flex; justify-content: center; align-items: center;';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                document.removeEventListener('keydown', escListener);
            }
        });

        const escListener = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                overlay.remove();
                document.removeEventListener('keydown', escListener);
            }
        };
        document.addEventListener('keydown', escListener);

        const panel = document.createElement('div');
        panel.id = 'mei-settings-panel';
        panel.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        const title = document.createElement('h2');
        title.textContent = `🔊 RVC連携 設定 (v${SCRIPT_VERSION})`;
        title.style.cssText = 'margin-top: 0; border-bottom: 1px solid #444; padding-bottom: 10px; margin-bottom: 20px; color: #8ab4f8; font-size: 1.5em;';
        panel.appendChild(title);

        // ----------------------------------------------------
        // 🌟 RVC ON/OFF スイッチ 🌟
        // ----------------------------------------------------
        const rvcEnableGroup = document.createElement('div');
        rvcEnableGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #444; padding-bottom: 15px;';

        const rvcEnableInput = document.createElement('input');
        rvcEnableInput.type = 'checkbox';
        rvcEnableInput.id = 'rvcEnabled';
        rvcEnableInput.checked = config.rvcEnabled || false;
        rvcEnableInput.style.cssText = 'width: 20px; height: 20px; margin-right: 10px; flex-shrink: 0;';
        rvcEnableGroup.appendChild(rvcEnableInput);

        const rvcEnableLabel = document.createElement('label');
        rvcEnableLabel.textContent = 'RVC連携を有効にする (ON: RVCを使用 | OFF: VOICEVOXを使用)';
        rvcEnableLabel.setAttribute('for', 'rvcEnabled');
        rvcEnableLabel.style.cssText = 'font-weight: bold; color: #e8eaed; cursor: pointer;';
        rvcEnableGroup.appendChild(rvcEnableLabel);
        panel.appendChild(rvcEnableGroup);

        // ----------------------------------------------------
        // 🌟 RVC設定項目 🌟
        // ----------------------------------------------------

        // --- 設定項目を横並びにする共通スタイル ---
        const createSettingGroup = (labelText, inputId, value, type = 'text', width = '100%', min = null, max = null, step = null, placeholder = '') => {
            const group = document.createElement('div');
            group.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;';

            const label = document.createElement('label');
            label.setAttribute('for', inputId);
            label.style.cssText = 'font-weight: bold; color: #9aa0a6; white-space: nowrap; margin-right: 15px; flex-shrink: 0;';
            label.textContent = labelText;
            group.appendChild(label);

            const input = document.createElement('input');
            input.type = type === 'file' ? 'text' : type;
            input.id = inputId;
            input.value = value;
            input.classList.add('mei-input-field');
            input.style.width = width;
            if (min !== null) {
                input.min = min;
            }
            if (max !== null) {
                input.max = max;
            }
            if (step !== null) {
                input.step = step;
            }
            if (placeholder) {
                input.setAttribute('placeholder', placeholder);
            }
            if (type === 'number') {
                input.style.textAlign = 'right';
            }
            input.setAttribute('autocomplete', 'off');

            group.appendChild(input);
            return {
                group,
                input,
            };
        };

        // --- セレクトボックスを作成する共通スタイル ---
        const createSettingSelect = (labelText, selectId, currentValue, options) => {
            const group = document.createElement('div');
            group.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;';

            const label = document.createElement('label');
            label.setAttribute('for', selectId);
            label.style.cssText = 'font-weight: bold; color: #9aa0a6; white-space: nowrap; margin-right: 15px; flex-shrink: 0;';
            label.textContent = labelText;
            group.appendChild(label);

            const select = document.createElement('select');
            select.id = selectId;
            select.classList.add('mei-input-field');
            select.style.width = '240px';
            // options は { value: '値', text: '表示名' } の配列を想定するわ
            options.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.text;
                if (currentValue === opt.value) {
                    option.selected = true;
                }
                select.appendChild(option);
            });

            group.appendChild(select);
            return {
                group,
                select,
            };
        };

        // RVC API URL
        const rvcApi = createSettingGroup('RVC WebUI URL:', 'rvcApiUrl', config.rvcApiUrl, 'url', '100%', null, null, null, '例: http://localhost:7897/');
        panel.appendChild(rvcApi.group);

        // --- ヘルパー関数: オプションをクリアする ---
        const clearOptions = (element) => {
            while (element.firstChild) {
                element.removeChild(element.firstChild);
            }
        };

        // --- モデルとインデックスの選択肢をAPIから取得し更新する ---
        async function updateRvcChoices(buttonElement) {
            const refreshUrl = `${config.rvcApiUrl.replace(/\/$/, '')}/run/infer_refresh`;

            try {
                const response = await new Promise((resolve, reject) => {
                    const xhr = GM_xmlhttpRequest({
                        method: 'POST',
                        url: refreshUrl,
                        data: JSON.stringify({
                            data: [],
                        }),
                        headers: {
                            "Content-Type": "application/json",
                        },
                        responseType: 'json',
                        timeout: 10000,
                        onload: (res) => resolve(res),
                        onerror: () => reject(new Error('RVC refresh connection error.')),
                        ontimeout: () => reject(new Error('RVC refresh timeout.')),
                    });
                });

                if (response.status !== 200 || !response.response || !response.response.data) {
                    throw new Error(`RVC refresh failed (Status: ${response.status})`);
                }

                const data = response.response.data;
                const modelUpdate = data[0];
                const indexUpdate = data[1];

                // ----------------------------------------------------
                // A. モデル選択肢の更新 (Select Box)
                // ----------------------------------------------------
                const modelChoices = modelUpdate && modelUpdate.choices ? modelUpdate.choices : [];
                const currentModel = rvcModel.select.value;

                clearOptions(rvcModel.select);
                let modelFound = false;

                modelChoices.forEach(choice => {
                    const [value, text,] = Array.isArray(choice) ? choice : [choice, choice,];
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = text;
                    if (value === currentModel) {
                        option.selected = true;
                        modelFound = true;
                    }
                    rvcModel.select.appendChild(option);
                });

                if (!modelFound) {
                    const option = document.createElement('option');
                    option.value = currentModel;
                    option.textContent = currentModel;
                    option.selected = true;
                    rvcModel.select.prepend(option);
                }

                console.log(`[RVC Config] モデルの選択肢を ${modelChoices.length} 件更新しました。`);

                // ----------------------------------------------------
                // B. インデックス選択肢の更新 (Select Box)
                // ----------------------------------------------------
                const indexChoices = indexUpdate && indexUpdate.choices ? indexUpdate.choices : [];
                const currentIndex = rvcIndex.select.value; // 現在の値を取得

                clearOptions(rvcIndex.select);

                // 【重要】[None]オプションを先頭に追加するわ
                const noneOption = document.createElement('option');
                noneOption.value = '';
                noneOption.textContent = '[None] 使用しない';
                if (currentIndex === '') {
                    noneOption.selected = true;
                }
                rvcIndex.select.appendChild(noneOption);

                let indexFound = false;
                indexChoices.forEach(choice => {
                    const [value,] = Array.isArray(choice) ? choice : [choice,];
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = value;

                    if (value === currentIndex && currentIndex !== '') {
                        option.selected = true;
                        indexFound = true;
                    }
                    rvcIndex.select.appendChild(option);
                });

                // 現在の値が見つからなかった場合、その値をオプションとして保持
                if (!indexFound && currentIndex !== '') {
                    const option = document.createElement('option');
                    option.value = currentIndex;
                    option.textContent = currentIndex;
                    option.selected = true;
                    rvcIndex.select.appendChild(option);
                }

                console.log(`[RVC Config] インデックスの選択肢を ${indexChoices.length} 件更新しました。`);

                // 🎊 成功！ボタンを元に戻す
                buttonElement.textContent = '✅ 更新完了';
                await new Promise(resolve => setTimeout(resolve, 1000)); // 1秒間だけ成功表示

            } catch (error) {
                console.error('[RVC Config] ❌ モデル/インデックスリストの取得に失敗しました:', error);

                // 😢 失敗！ボタンにエラーを表示
                buttonElement.textContent = '❌ 取得失敗';
                await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒間エラー表示

            } finally {
                // どちらの結果でも最終的に元の表示に戻す
                buttonElement.disabled = false;
                buttonElement.textContent = '🔄 リストを更新';
            }
        }

        // --- RVC MODEL NAME ---
        const rvcModelOptions = [{
            value: config.rvcModel,
            text: config.rvcModel,
        },];
        const rvcModel = createSettingSelect('モデルファイル名 (.pth):', 'rvcModel', config.rvcModel, rvcModelOptions);
        rvcModel.select.style.height = '36px'; // align-items: center; が効きにくい場合の保険として、selectの高さをボタン(+2px)に合わせる

        // --- リフレッシュボタン ---
        const rvcRefreshButton = document.createElement('button');
        rvcRefreshButton.id = 'rvcRefreshButton';
        rvcRefreshButton.textContent = '🔄 リストを更新';
        rvcRefreshButton.style.cssText = 'margin-top: 4px; margin-left: 8px; padding: 4px 6px; font-size: 12px; width:100px; height:34px; background: #333; color: white; border: 1px solid #5f6368; border-radius: 8px; cursor: pointer; flex-shrink: 0;';

        // セレクトボックスの隣にボタンを追加
        rvcModel.group.appendChild(rvcRefreshButton);
        rvcRefreshButton.addEventListener('click', (e) => {
            e.preventDefault();
            if (rvcRefreshButton.disabled) {
                return;
            }
            rvcRefreshButton.disabled = true;
            rvcRefreshButton.textContent = '取得中...';
            updateRvcChoices(rvcRefreshButton);
        });

        panel.appendChild(rvcModel.group);

        // --- RVC INDEX NAME ---
        const rvcIndexOptions = [{
            value: '',
            text: '[None] 使用しない', // クリアするための選択肢
        }, {
            value: config.rvcIndex,
            text: config.rvcIndex,
        },
        ];
        const rvcIndex = createSettingSelect(
            'インデックスファイル名 (.index):',
            'rvcIndexSelect', // selectのID
            config.rvcIndex,
            rvcIndexOptions
        );
        rvcIndex.select.style.height = '36px'; // selectの高さ調整
        rvcIndex.select.style.width = '240px'; // 幅を合わせる
        panel.appendChild(rvcIndex.group);

        // --- 起動時にリストを自動で更新！ ---
        setTimeout(() => {
            rvcRefreshButton.disabled = true;
            rvcRefreshButton.textContent = '取得中...';
            updateRvcChoices(rvcRefreshButton);
        }, 100);

        // RVC PITCH SHIFT
        const rvcPitch = createSettingGroup('ピッチ変更 (-12～12):', 'rvcPitch', config.rvcPitch, 'number', '80px', '-12', '12', '1');
        panel.appendChild(rvcPitch.group);

        // RVC RATIO（検索特徴率）
        const rvcRatio = createSettingGroup('検索特徴率 (0.0～1.0) [0.75]:', 'rvcRatio', config.rvcRatio, 'number', '80px', '0.0', '1.0', '0.1');
        panel.appendChild(rvcRatio.group);

        // RVC ALGORITHM
        const rvcAlgorithmGroup = document.createElement('div');
        rvcAlgorithmGroup.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;';

        const rvcAlgorithmLabel = document.createElement('label');
        rvcAlgorithmLabel.setAttribute('for', 'rvcAlgorithm');
        rvcAlgorithmLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; white-space: nowrap; margin-right: 15px; flex-shrink: 0;';
        rvcAlgorithmLabel.textContent = 'アルゴリズム (pm|harvest|crepe|rmvpe):';
        rvcAlgorithmGroup.appendChild(rvcAlgorithmLabel);

        const rvcAlgorithmSelect = document.createElement('select');
        rvcAlgorithmSelect.id = 'rvcAlgorithm';
        rvcAlgorithmSelect.style.width = '100px';
        rvcAlgorithmSelect.classList.add('mei-input-field');
        ['pm', 'harvest', 'crepe', 'rmvpe',].forEach(alg => {
            const option = document.createElement('option');
            option.value = alg;
            option.textContent = alg;
            if (config.rvcAlgorithm === alg) {
                option.selected = true;
            }
            rvcAlgorithmSelect.appendChild(option);
        });
        rvcAlgorithmGroup.appendChild(rvcAlgorithmSelect);
        panel.appendChild(rvcAlgorithmGroup);

        const rvcResample = createSettingGroup('リサンプリング周波数 (0～48000):', 'rvcResample', config.rvcResample, 'number', '80px', '0', '48000', '100');
        panel.appendChild(rvcResample.group);
        // リサンプリングの説明を追加するクールな作業
        const resampleDesc = document.createElement('p');
        resampleDesc.style.cssText = 'color: #7b7d82; font-size: 0.8em; margin: -10px 0 20px 0; padding-left: 20px;';
        resampleDesc.textContent = '入力音声のリサンプリング周波数よ。（推奨値：48000）';
        panel.appendChild(resampleDesc);

        // ----------------------------------------------------
        // 🌟 最終フッターグループ 🌟
        // ----------------------------------------------------

        const finalFooter = document.createElement('div');
        finalFooter.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-top: 20px;';

        // 🔊 VOICEVOX連携 設定ボタン
        const vvSettingsBtn = document.createElement('button');
        vvSettingsBtn.textContent = '🔊 VOICEVOX連携';
        vvSettingsBtn.classList.add('mei-button', 'mei-button-secondary');
        vvSettingsBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; margin-right: auto;';
        vvSettingsBtn.addEventListener('click', () => {
            document.removeEventListener('keydown', escListener);
            overlay.remove();
            openSettings();
        });

        const saveCloseGroup = document.createElement('div');
        saveCloseGroup.style.cssText = 'display: flex; gap: 10px;';

        // 保存ボタン
        const saveBtn = document.createElement('button');
        saveBtn.textContent = '保存';
        saveBtn.classList.add('mei-button', 'mei-button-primary');
        saveBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; width: 100px;';

        // 閉じるボタン
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '閉じる';
        closeBtn.classList.add('mei-button', 'mei-button-secondary');
        closeBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; width: 100px;';
        closeBtn.onclick = () => {
            document.removeEventListener('keydown', escListener);
            overlay.remove();
        };

        // グループにボタンを追加
        saveCloseGroup.appendChild(saveBtn);
        saveCloseGroup.appendChild(closeBtn);

        // 最終フッターに左のボタンと右のグループを追加
        finalFooter.appendChild(vvSettingsBtn);
        finalFooter.appendChild(saveCloseGroup);
        panel.appendChild(finalFooter);

        // --- 保存処理 ---
        saveBtn.addEventListener('click', () => {
            const newRvcApiUrl = rvcApi.input.value.trim();
            const newRvcModel = rvcModel.select.value.trim();
            const newRvcIndex = rvcIndex.select.value.trim();
            const newRvcPitch = parseFloat(rvcPitch.input.value);
            const newRvcRatio = parseFloat(rvcRatio.input.value);
            const newrvcAlgorithm = rvcAlgorithmSelect.value;
            const newRvcResample = parseInt(document.getElementById('rvcResample').value);
            const newRvcEnabled = rvcEnableInput.checked;

            // バリデーション
            if (newRvcApiUrl === '' || newRvcModel === '' ||
                isNaN(newRvcPitch) || newRvcPitch < -12 || newRvcPitch > 12 ||
                isNaN(newRvcRatio) || newRvcRatio < 0 || newRvcRatio > 1 ||
                isNaN(newRvcResample) || newRvcResample < 0 || newRvcResample > 48000) {
                showToast('全項目を正しく入力してね！', false);
                return;
            }

            const currentUIValues = {
                rvcEnabled: newRvcEnabled,
                rvcApiUrl: newRvcApiUrl,
                rvcModel: newRvcModel,
                rvcIndex: newRvcIndex,
                rvcPitch: newRvcPitch,
                rvcRatio: newRvcRatio,
                rvcAlgorithm: newrvcAlgorithm,
                rvcResample: newRvcResample,
            };

            saveModifiedConfigOnly(currentUIValues);
            if (newRvcEnabled) {
                loadRvcModel();
            }

            showToast('✅ RVC連携設定を保存したわ！', true);

            document.removeEventListener('keydown', escListener);
            overlay.remove();
        });

        // DOMにパネルとオーバーレイを追加
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
    }

    /**
     * UIで変更された項目のみを検出し、保存済みデータにマージする関数
     * @param {Object} currentUIValues - 設定画面の入力値から作ったオブジェクト
     */
    function saveModifiedConfigOnly(currentUIValues) {
        const savedConfig = GM_getValue(STORE_KEY, {});
        const diff = {};
        let hasChanges = false;

        // UIに存在するキーのみを比較して差分を抽出
        Object.keys(currentUIValues).forEach(key => {
            // 現在のconfigと入力値が異なる場合のみ差分として記録
            if (config[key] !== currentUIValues[key]) {
                diff[key] = currentUIValues[key];
                hasChanges = true;
            }
        });

        if (hasChanges) {
            // 保存済みデータに差分を適用
            const newSavedConfig = { ...savedConfig, ...diff, };
            GM_setValue(STORE_KEY, newSavedConfig);

            // メモリ上の config も最新化（これにより、保存した設定 + コード側のデフォルト設定の最新状態になる）
            config = { ...DEFAULT_CONFIG, ...newSavedConfig, };

            // console.log('[Config] 差分保存を実行:', diff);
        }
    }

    // グローバルキーイベントリスナー
    function handleGlobalKeyDown(e) {
        // IME入力中は処理しない
        if (e.isComposing || e.keyCode === 229) {
            return;
        }

        // 設定が読み込まれていない、または設定が無効な場合は何もしない
        if (!config || !config.shortcutKey) {
            return;
        }

        const isControl = e.ctrlKey || e.metaKey; // CtrlまたはCommand
        const isAlt = e.altKey;
        const isShift = e.shiftKey;
        const button = document.getElementById('convertButton');

        // ボタンが存在しないか、設定パネルが開いている場合は何もしない
        if (!button || document.getElementById('mei-settings-overlay')) {
            return;
        }

        // Keyを大文字化
        let key = e.key;
        if (key.length === 1) {
            key = key.toUpperCase();
        } else if (key === ' ') {
            key = 'Space';
        }

        let pressedShortcut = '';

        if (isControl) {
            pressedShortcut += 'Ctrl+';
        } // 'Ctrl' に統一
        if (isAlt) {
            pressedShortcut += 'Alt+';
        }
        if (isShift) {
            pressedShortcut += 'Shift+';
        }

        // 最後のキーが修飾キーではないことを確認（Control, Shift, Alt, Meta）
        if (key !== 'Control' && key !== 'Shift' && key !== 'Alt' && key !== 'Meta') {
            pressedShortcut += key;
        }

        // キーが一致したら実行
        if (pressedShortcut === config.shortcutKey) {
            e.preventDefault(); // デフォルトの動作を抑制（ブラウザショートカットなど）
            e.stopPropagation();

            // 再生中または合成中なら停止、それ以外なら再生
            if (isPlaying) {
                stopPlayback();
            } else if (isPause && audioContext) {
                resumeContext();
            } else if (isConversionStarting || currentXhrs.length > 0) {
                stopConversion();
            } else {
                // 再生開始。手動操作なので isAutoPlay は false
                startConversion(false);
            }
        }
    }

    /**
     * 最後のGeminiの回答パネルから、読み上げ用のテキストを抽出する。
     * @returns {string} - 抽出されたクリーンなテキスト。処理中断時は空文字列。
     */
    function responseAnswerText() {
        let allResponseContainers = [];
        for (const selector of config.selectorsResponse) {
            const containers = document.querySelectorAll(selector.container);
            if (containers.length > 0) {
                allResponseContainers = containers;
                break; // 最初にマッチしたセレクタで決定
            }
        }
        if (allResponseContainers.length === 0) {
            return '';
        }

        // 最後の回答パネルを取得
        const textContainer = allResponseContainers[allResponseContainers.length - 1];
        if (!textContainer) {
            return '';
        }

        // DOMを汚染しないようにクローンを作成
        const clonedContainer = textContainer.cloneNode(true);

        /* * * デバッグコード: detection 検出時にDOM構造を出力 * * */
        if (DEBUG_DETECTION) {
            const detection = 'お待ちください'; // 検知ワード
            const detect_length = 100;
            const rawText = clonedContainer.innerText || '';
            if (rawText.includes(detection)) {
                // 検出された回答パネル（クローン）のouterHTMLを出力。
                console.log(`[Debug] [${getFormattedDateTime()}] 【検出された回答パネルのHTML】(innerText): \n${rawText.substring(0, detect_length).replace(/\n/g, ' ')}...`);
                console.log(clonedContainer.outerHTML);

                // 5階層上の要素のタグとクラス名だけを表示
                let targetElement = clonedContainer;
                let parentInfo = '';
                for (let i = 0; i < 5; i++) {
                    if (targetElement.parentElement) {
                        targetElement = targetElement.parentElement;
                        parentInfo += targetElement.tagName + (targetElement.className ? '.' + targetElement.className.split(' ').join('.') : '') + ' > ';
                    } else {
                        break;
                    }
                }
                console.log("【親階層情報】(5階層まで): " + parentInfo.slice(0, -3));
            }
        }
        /* * * デバッグコードここまで * * */

        // 応答生成中｜停止のステータスチェック
        const isInterrupted = config.selectorsToInterrupt.some(selector => {
            return clonedContainer.querySelector(selector);
        });
        if (isInterrupted) {
            return '';
        }

        // すべての除去対象要素をループで探し、除去する（グローバル配列を使用！）
        config.selectorsToRemove.forEach(selector => {
            const elements = clonedContainer.querySelectorAll(selector);
            elements.forEach(element => element.remove());
        });

        // innerTextを取る「前」に「間」を仕込むわ
        const blocks = clonedContainer.querySelectorAll('p, th, td, li, h1, h2, h3, h4, h5, h6');
        blocks.forEach(block => {
            // block.textContent だと子要素（bタグなど）のテキストも全部拾えるわ
            const content = block.textContent.trim();

            // 中身があって、かつ末尾が句読点で終わっていない場合だけ「、」を足す
            if (content && !/[。？！…!?.]$/.test(content)) {
                // block.append('、') を使うと、既存のHTML構造を壊さずに末尾にテキストを追加できるわよ
                block.insertAdjacentText('beforeend', '、');
            }
        });

        let text = clonedContainer.innerText || '';

        // 1. コードブロック、コメント、タイトル記号の除去
        // g: グローバル検索, i: 大文字小文字を区別しない, m: 複数行モード
        text = text.replace(/```[a-z]*[\s\S]*?```|^\s*[#*]+\s/gim, ' ');

        // テキストコンテンツによる中断チェック
        if (text.startsWith('お待ちください')) {
            return '';
        }
        if (text.includes('Analyzing input...') || text.includes('Generating response...')) {
            return '';
        }

        // 2. 改行（\n）を「、」に置換して、物理的な「間」を確保するわ！
        // text = text.replace(/[\n|]+/g, '、');

        if (DEBUG_REGEX && DEBUG_TEXT != clonedContainer.innerText && clonedContainer.innerText != '') {
            console.log(`[Debug] [${getFormattedDateTime()}] Before Remove Regex （${text.length}文字）\n${text.trim()}`);
        }

        // 3. 文字列置換
        if (config.textsToReplaceRegex) {
            config.textsToReplaceRegex.forEach(item => {
                const regex = new RegExp(item.pattern, 'gim'); // 大文字小文字、全角半角の揺れに対応
                text = text.replace(regex, item.replacement);
            });
        }

        // 4. 定型文・NGワードの除去
        config.textsToRemoveRegex.forEach(regexString => {
            // gフラグ（グローバル）を追加し、全文からマッチしたものを全て除去するわ
            const regex = new RegExp(regexString, 'gi');
            // 除去した箇所を空白に置き換えて、後のクリーンアップで連続空白をまとめるわ
            text = text.replace(regex, ' ');
        });

        if (DEBUG_REGEX && DEBUG_TEXT != clonedContainer.innerText && clonedContainer.innerText != '') {
            console.log(`[Debug] [${getFormattedDateTime()}] Before Remove MarkDown （${text.length}文字）\n${text.trim()}`);
        }

        // 5-1. その他のマークダウン記号の除去（[pause: を除外）
        text = text.replace(/\[pause:(\d+(?:\.\d+)?)\]/g, '::$1::');
        // 5-2. ここで記号を全部消す
        text = text.replace(/(?<!:):(?!:)|(?<!\d)\.(?!\d)|(\*{1,2}|_{1,2}|~{1,2}|#|\$|>|-|\[|\]|`|\(|\)|<|>|\\|\?|!|;|=|\+|\|)/gim, ' ');
        // 5-3. ::を元に戻す
        text = text.replace(/::(\d+(?:\.\d+)?)::/g, '[pause:$1]');

        // 6. 連続する空白（全角・タブ含む）を1つにまとめる
        text = text.replace(/[ \u3000\t]{2,}/g, ' ');

        // 7. 連続する句読点（。。 や ！。 など）を1つにまとめる
        text = text.replace(/([.!?、。？！]{2,})/g, function(match, p1) {
            return p1.substring(0, 1);
        });

        if (DEBUG_REGEX && DEBUG_TEXT != clonedContainer.innerText && clonedContainer.innerText != '') {
            console.log(`--- [Debug] [${getFormattedDateTime()}] return （${text.length}文字） ---\n${text.trim()}\n------------------`);
        }

        DEBUG_TEXT = clonedContainer.innerText || '';

        // 最後に、前後の余計なスペースをトリミングして完成！
        return text.trim();
    }

    // 再生・合成中の処理をすべてリセットし、ボタンを初期状態に戻す関数
    function resetOperation(isStopRequest = false) {
        //  トーストを即座にクリアするわ！
        if (typeof toastTimeoutId !== 'undefined' && toastTimeoutId) {
            clearTimeout(toastTimeoutId);
            toastTimeoutId = null; // 自動非表示タイマーをキャンセル
        }
        const toastId = 'spitch-toast';
        const existingToast = document.getElementById(toastId);
        if (existingToast) {
            existingToast.remove();
        }

        // 1. Audioリセット
        const wasPlaying = currentAudio !== null; // リセット前の状態をチェック
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = '';
            currentAudio = null;
        }
        isPlaying = false;

        // 2. XHR/合成リセット（中断）
        const wasConverting = currentXhrs.length > 0; // リセット前の状態をチェック
        if (wasConverting) {
            currentXhrs.forEach(xhr => {
                if (xhr && xhr.readyState !== 4) { // 完了していなければ中断
                    xhr.abort();
                }
            });
            currentXhrs = []; // 配列を空に戻すわ！
        }

        isConversionStarting = false;

        // 3. メッセージの決定と表示
        if (isStopRequest) { // 手動で停止ボタンが押された場合のみメッセージを出す
            if (wasConverting) {
                // 合成中だった場合は「中断」
                showToast('■ 音声合成を中断したわ', false);
            } else if (wasPlaying) {
                // 合成は終わって再生中だった場合は「停止」
                showToast('■ 音声再生を停止しました', false);
            }
            // その他の場合はメッセージなし
        }

        // 4. ボタンリセット
        updateButtonState();

        // サンプルボタンが合成中・再生中だった場合もリセット
        const sampleButton = document.getElementById('mei-sample-play-btn');
        if (sampleButton && sampleButton.textContent === '🔇 再生停止') {
            resetSampleButtonState(sampleButton);
        } else if (sampleButton && sampleButton.textContent === '⏰ 合成中...') {
            resetSampleButtonState(sampleButton);
        }
    }

    // 停止処理
    function stopConversion() {
        if (isPlaying || currentXhrs.length > 0) {
            resetOperation(true); // 再生中または合成中の停止
        } else {
            resetOperation(); // 念のためリセット
        }
    }

    // サンプル再生関連
    function resetSampleButtonState(button) {
        if (button) {
            button.textContent = '🔊 サンプル再生';
            button.style.backgroundColor = '#5cb85c'; // Green
            button.onclick = () => startSampleConversion();
        }
    }

    /**
     * VOICEVOXからテスト音声を取得し、必要に応じてRVC変換を行い、再生するわ。
     * @param {object} audioQuery - VOICEVOXから取得したオーディオクエリオブジェクト
     * @param {HTMLButtonElement} button - サンプル再生ボタン
     * @param {string} text - テストに用いたテキスト
     * @param {number} speakerId - 使用したスピーカーID
     * @param {string} currentApiUrl - 入力欄から取得したリアルタイムなAPI URL
     */
    function synthesizeSampleAudio(audioQuery, button, text, speakerId, apiUrl) {
        showToast(`テストテキスト合成中...`, null);

        const synthesizeUrl = `${apiUrl}/synthesis?speaker=${speakerId}`;

        const xhr = GM_xmlhttpRequest({
            method: 'POST',
            url: synthesizeUrl,
            headers: {
                'Content-Type': 'application/json',
            },
            data: JSON.stringify(audioQuery),
            responseType: 'blob',
            onload: async function(response) {
                currentXhrs = currentXhrs.filter(item => item !== xhr); // 完了したXHRを配列から削除

                if (response.status === 200 && response.response) {
                    let playableBlob = response.response; // VOICEVOX original Blob
                    let isRvcSuccess = false;

                    // --- RVC変換ロジック ---
                    if (config.rvcEnabled) {
                        try {
                            showToast('RVC変換中...', null);

                            // 1. BlobをArrayBufferに変換
                            const arrayBuffer = await playableBlob.arrayBuffer();

                            // 2. RVC変換を実行
                            const rvcBuffer = await requestRvcConversion(arrayBuffer);

                            // 3. Blobに戻す
                            playableBlob = new Blob([rvcBuffer,], { type: 'audio/wav', });

                            isRvcSuccess = true;
                            showToast('RVC変換完了！再生するわ！', true);

                        } catch (rvcError) {
                            // 【フォールバック】RVC変換失敗時の処理
                            console.error('[Sample Playback] ❌ RVC変換失敗（フォールバック）:', rvcError);
                            showToast('😭 RVC連携失敗！VOICEVOXオリジナル音声で代替再生するわ。', false);
                            // playableBlob は VOICEVOX original Blob のまま（フォールバック）
                        }
                    }

                    // --- 再生処理 (playableBlobがRVC変換済みかオリジナル音声になる) ---
                    const audioUrl = URL.createObjectURL(playableBlob);
                    const audio = new Audio(audioUrl);
                    currentAudio = audio;
                    isPlaying = true;

                    audio.onplay = () => {
                        if (button) {
                            button.textContent = '🔇 再生停止';
                            button.style.backgroundColor = '#dc3545'; // Red
                        }
                    };

                    // AudioContextを使わないので、Autoplayブロックは発生しにくいけど、一応エラーハンドリングは任せるわ
                    audio.play().catch(e => {
                        console.error('オーディオ再生エラー:', e);
                        showToast('😭 自動再生ブロック。ブラウザのどこかをクリックしてからもう一度試してみて！', false);
                        resetOperation();
                        resetSampleButtonState(button);
                    });

                    audio.onended = () => {
                        URL.revokeObjectURL(audioUrl);
                        // 再生終了時に状態をリセット（メインボタンは操作しない）
                        resetOperation();
                        resetSampleButtonState(button); // サンプルボタンを再開表示に戻す
                    };

                    const finalToast = isRvcSuccess
                        ? 'RVCテスト音声再生中よ！'
                        : 'テスト音声再生中よ！';
                    showToast(finalToast, true);

                } else {
                    // VOICEVOX合成失敗
                    showToast(`VOICEVOX合成に失敗したわ... (Status: ${response.status})`, false);
                    console.error('VOICEVOX Synthesize Error:', response);
                    resetOperation();
                    resetSampleButtonState(button);
                }
            },
            onerror: function(error) {
                currentXhrs = currentXhrs.filter(item => item !== xhr); // 完了したXHRを配列から削除
                showToast('テスト音声の合成中にエラーが発生したわ。', false);
                console.error('VOICEVOX Synthesize Connection Error:', error);
                resetOperation();
                resetSampleButtonState(button);
            },
        });
        currentXhrs.push(xhr); // XHRオブジェクトを保存
    }

    function startSampleConversion() {
        const SAMPLE_TEXT = '音声のテストだよ！この声で読み上げするよ！';
        const button = document.getElementById('mei-sample-play-btn');
        const speakerIdInput = document.getElementById('speakerId');
        const apiUrlInput = document.getElementById('apiUrl');

        if (isPlaying || currentXhrs.length > 0) {
            showToast('今は再生中か合成中よ。停止ボタンで止めてね。', false);
            return;
        }

        // 入力値を取得し、不正な値ならエラー
        if (!speakerIdInput || !apiUrlInput) {
            return;
        }
        const currentSpeakerId = parseInt(speakerIdInput.value, 10);
        if (isNaN(currentSpeakerId) || currentSpeakerId < 0) {
            showToast('スピーカーIDが不正よ！半角数字を確認してね。', false);
            return;
        }
        const currentApiUrl = apiUrlInput.value.trim().replace(/\/+$/, '');
        if (!currentApiUrl) {
            showToast('API URLが空欄よ！入力してね。', false);
            return;
        }

        // 合成中の状態
        if (button) {
            button.textContent = '⏰ 合成中...';
            button.style.backgroundColor = '#6c757d';
            button.onclick = () => stopConversion(); // グローバル停止関数を呼ぶ
        }

        const audioQueryUrl = `${currentApiUrl}/audio_query`;
        const queryParams = new URLSearchParams({
            text: SAMPLE_TEXT,
            speaker: currentSpeakerId,
        });

        const xhr = GM_xmlhttpRequest({
            method: 'POST',
            url: `${audioQueryUrl}?${queryParams.toString()}`,
            headers: {
                'Content-Type': 'application/json',
            },
            onload: function(response) {
                currentXhrs = currentXhrs.filter(item => item !== xhr); // 完了したXHRを配列から削除
                if (response.status === 200) {
                    const audioQuery = JSON.parse(response.responseText);
                    synthesizeSampleAudio(audioQuery, button, SAMPLE_TEXT, currentSpeakerId, currentApiUrl);
                } else {
                    showToast(`VOICEVOXとの連携に失敗したわ... (Status: ${response.status})`, false);
                    console.error('VOICEVOX Query Error:', response);
                    resetOperation();
                    resetSampleButtonState(button);
                }
            },
            onerror: function(error) {
                currentXhrs = currentXhrs.filter(item => item !== xhr); // 完了したXHRを配列から削除
                showToast('VOICEVOXエンジンに接続できないわ... 起動しているか確認してね。', false);
                console.error('VOICEVOX Connection Error:', error);
                resetOperation();
                resetSampleButtonState(button);
            },
        });
        currentXhrs.push(xhr); // XHRオブジェクトを保存
    }

    // ========= Download =========

    /**
     * Blobデータを指定したファイル名でダウンロードする
     * @param {Blob} blob Blobオブジェクト
     * @param {string} filename ダウンロードファイル名
     */
    function downloadBlob(blob, filename) {
        // 1. BlobからURLを生成 (メモリ上のオブジェクトを参照する一時的なURL)
        const url = URL.createObjectURL(blob);

        // 2. 仮想的なアンカー（<a>）要素を作成
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;

        // 3. クリックイベントを発生させてダウンロード開始
        document.body.appendChild(a);
        a.click();

        // 4. 後処理（メモリ解放と要素削除）
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // console.log(`${filename} のダウンロードを開始しました。`);
    }

    // ダウンロード
    async function startVoiceDownload() {
        try {
            let text = responseAnswerText();
            if (!text || text.trim() === '') {
                // showToast('回答テキストが取得できなかったか、全て除去されたわ...', false);
                return;
            }

            // キャッシュチェック
            const requestCacheKey = generateCacheKey(text);
            const cachedHash = GM_getValue(LAST_CACHE_HASH, null);

            if (requestCacheKey === cachedHash) {
                const cachedData = GM_getValue(LAST_CACHE_DATA, null); // Base64 URI
                if (cachedData) {
                    const wavBlob = base64UriToBlob(cachedData, 'audio/wav'); // 変換

                    // 「/ または :」をハイフンに置換し、半角スペースをアンダースコアに
                    const filename = getFormattedDateTime().replace(/[/:]/g, '-').replace(' ', '_');
                    downloadBlob(wavBlob, `neon_spitch_${filename}.wav`);
                }
            }
        } catch (e) {
            console.error("[Cache Download] ダウンロード処理でエラーが発生しました:", e);
        }
    }

    // ========= RVC連携用ヘルパー関数 =========

    /**
     * ArrayBufferをBase64文字列に変換するヘルパー関数（同期）
     * @param {ArrayBuffer} buffer
     * @returns {string} Base64文字列
     */
    function arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        // Base64に変換して返すわ
        return btoa(binary);
    }

    /**
     * Base64 URI (またはプレーンなBase64文字列) を Blob オブジェクトに変換する
     * @param {string} base64WavData - Base64 URIまたはBase64文字列
     * @param {string} defaultMimeType - Base64 URIにMIMEタイプがない場合のデフォルト (例: 'audio/wav')
     * @returns {Blob} Blobオブジェクト
     */
    function base64UriToBlob(base64WavData, defaultMimeType = 'audio/wav') {
        let base64 = base64WavData;
        let mimeType = defaultMimeType;

        // 1. Data URIヘッダーの処理 (Data URI形式: data:MIME/TYPE;base64,DATA)
        if (base64.startsWith('data:')) {
            const parts = base64.split(',');
            base64 = parts[1];

            // ヘッダーからMIMEタイプを抽出
            const header = parts[0];
            const match = header.match(/:(.*?)(;|$)/);
            if (match && match[1]) {
                mimeType = match[1];
            }
        }

        // 2. Base64デコードとBlob生成
        const binary = atob(base64);
        const len = binary.length;
        const array = new Uint8Array(len);

        for (let i = 0; i < len; i++) {
            array[i] = binary.charCodeAt(i);
        }

        return new Blob([array.buffer,], {
            type: mimeType,
        });
    }

    // ========= RVC連携 音声合成関数 =========

    /**
     * VOICEVOXのArrayBuffer（WAVデータ）をRVCサーバーで変換し、RVC変換後の音声データをArrayBuffer形式で返すわ。
     * GradioスタイルのAPIエンドポイントに対応
     * @param {ArrayBuffer} voicevoxArrayBuffer - VOICEVOXから合成されたWAV ArrayBuffer
     * @returns {Promise<ArrayBuffer>} - RVC変換後のWAVデータ (ArrayBuffer)
     */
    async function requestRvcConversion(voicevoxArrayBuffer) {
        // ArrayBufferをBase64 URIに変換するわ
        const base64Audio = arrayBufferToBase64(voicevoxArrayBuffer);
        const inputAudioDataUri = 'data:audio/wav;base64,' + base64Audio;

        // RVC APIのペイロード形式に合わせるわ
        const inputAudioBase64 = {
            name: "voicevox_source.wav",
            data: inputAudioDataUri,
        };

        // URLの末尾のスラッシュを削除し、エンドポイントを結合
        const convertUrl = `${config.rvcApiUrl.replace(/\/$/, '')}/run/infer_convert`;

        // RVC APIのJSONボディを作成
        const rvcRequestBody = {
            data: [
                config.rvcNumber,       // 00. 話者ID (0～112) [0]
                null,                          // 01. 元音声のファイルパス（base64で送るのでなし）
                config.rvcPitch,        // 02. ピッチシフト (-12～12) [12]
                inputAudioBase64,              // 03. 変換元の音声データ（Base64 URI文字列を直接挿入！）
                config.rvcAlgorithm,    // 04. ピッチ抽出アルゴリズム (pm|harvest|crepe|rmvpe) [rmvpe]
                '',                            // 05. 特徴検索ライブラリへのパス（[6]で指定しているのでなし）（nullはダメ）
                config.rvcIndex || '',  // 06. インデックスパス [logs\rvcIndex.index]
                config.rvcRatio,        // 07. 検索特徴率 (0～1) [0.75]
                config.rvcMedianFilter, // 08. メディアンフィルタ (0～7) [3]
                config.rvcResample,     // 09. リサンプリング (0～48000) [0]
                config.rvcEnvelope,     // 10. エンベロープの融合率 (0～1) [0.25]
                config.rvcArtefact,     // 11. 明確な子音と呼吸音を保護 (0～0.5) [0.33]
            ],
        };

        let xhr;

        try {
            const base64Response = await new Promise((resolve, reject) => {
                xhr = GM_xmlhttpRequest({
                    method: 'POST',
                    url: convertUrl,
                    data: JSON.stringify(rvcRequestBody),
                    headers: { "Content-Type": "application/json", },
                    responseType: 'json',
                    timeout: VOICEVOX_TIMEOUT_MS, // グローバル定数を使用
                    onload: (response) => {
                        // 応答データをコンソールにダンプして確認
                        console.log('[RVC Conversion] RVCサーバーからの応答:', response);

                        // 応答の3番目の要素 (インデックス[2]) から data プロパティを抽出
                        if (response.status === 200 && response.response?.data?.[2]?.data) {
                            resolve(response.response.data[2].data); // Base64 URI文字列を返す
                        } else {
                            // 失敗ステータス: 応答がJSONじゃない場合も考慮して安全にパース
                            const detail = response.response?.detail || response.statusText || 'Unknown Error';
                            reject(`RVC失敗: ${detail}`);
                        }
                    },
                    onerror: () => reject(new Error('RVC接続エラー')),
                    ontimeout: () => reject(new Error('RVCタイムアウト')),
                    onabort: () => reject(new Error('RVC中断')),
                });
                currentXhrs.push(xhr); // XHRリストに追加
                updateButtonState();
            });

            // Base64 URIが正しいかチェック
            if (!base64Response?.startsWith('data:audio/wav;base64,')) {
                throw new Error('不正な音声データ形式よ');
            }

            // --- Base64 URIからArrayBufferへの変換 ---
            const base64 = base64Response.split(',')[1];
            const binary = atob(base64);
            const buffer = new Uint8Array(binary.length);

            // バイナリデータをArrayBufferに書き込む
            for (let i = 0; i < binary.length; i++) {
                buffer[i] = binary.charCodeAt(i);
            }

            return buffer.buffer;

        } finally {
            // 成功しても失敗してもリストから削除
            if (xhr) {
                currentXhrs = currentXhrs.filter(item => item !== xhr);
                updateButtonState();
            }
        }
    }

    /**
     * RVC連携の全処理（VOICEVOX Query/Synthesis + RVC変換）をストリーミングで実行する
     * @param {string} text - 合成するテキスト（responseAnswerText()の結果）
     * @param {boolean} isAutoPlay - 自動再生フラグ
     * @param {string} cacheKey - 生成されたキャッシュキー (ストリーミング中はキャッシュ処理をスキップ)
     */
    async function synthesizeRvcAudio(text, isAutoPlay, cacheKey) {
        if (!config.rvcEnabled) {
            return;
        } // RVC無効なら即終了（ガード句）

        // 1. 分割
        const MAX_CHUNK_LENGTH = config.chunkSize || DEFAULT_CHUNK_SIZE;
        let chunks = splitTextForSynthesis(text, MAX_CHUNK_LENGTH);

        // 2. 最大チャンク数制限
        if (chunks.length > config.maxChunks) {
            chunks = chunks.slice(0, config.maxChunks);
            chunks.push("。……。指定の分割数を超えたため、読み上げを終了したわ。");
            showToast(`最大チャンク数(${config.maxChunks})を超えたため、制限をかけたわよ。`, false);
        }

        isConversionAborted = false;

        console.log('[RVC] 音声データを合成準備中... (ストリーミング版)');

        // モデルファイル存在チェック
        if (!config.rvcModel) {
            showToast('😭 連携失敗: RVC モデルファイル名が設定されてないわ。', false);
            console.error('[RVC Error] RVC Model path is empty.');
            stopPlayback(); // ボタン状態をリセット
            return;
        }
        loadRvcModel(); // RVCモデルのロード処理（初回のみ）

        // RVC失敗時のフォールバックを管理するフラグ
        let rvcFailed = false;
        const successfulRvcBlobs = []; // 成功したRVC変換を一時的に格納する配列

        // ⚙️【共通関数の呼び出し】これでテキスト解析部分の重複コードが完全消滅！
        const allSubQueries = buildAllSubQueries(chunks);
        const totalAllParts = allSubQueries.length;

        try {
            initStreamingPlayback(isAutoPlay); // ストリーミング再生を初期化

            for (let k = 0; k < totalAllParts; k++) {
                const item = allSubQueries[k];
                let audioQuery = item.query;

                // 合成中断要求チェック
                if (isConversionAborted) {
                    console.log('[RVC] 合成中断要求が確認されたわ。ループを終了するわね。');
                    throw new Error('RVC Synthesis Aborted by User Request');
                }

                // 進捗トーストとログを正しい通し番号（k+1 / totalAllParts）に一元化
                if (!isPlaying) {
                    showToast(`WAVデータを生成中... （${item.textLength}/${text.length}文字）[${k + 1}/${totalAllParts}]`, null);
                }
                console.log(`[VOICEVOX|RVC] [${getFormattedDateTime()}] WAVデータを生成中... （${item.textLength}/${text.length}文字）[${k + 1}/${totalAllParts}]`);

                // --- 1. VOICEVOX Audio Query の取得 / パラメータ適用 ---
                if (item.type === 'text') {
                    if (DEBUG) {
                        console.log(`[SUB-QUERY] RVC用テキスト部分を生成中: "${item.text}"`);
                    }
                    audioQuery = await fetchVoicevoxQuery(item.text, k + 1, totalAllParts);

                    audioQuery.speedScale      = config.speedScale      ?? 1.0;
                    audioQuery.pitchScale      = config.pitchScale      ?? 0.0;
                    audioQuery.intonationScale = config.intonationScale ?? 1.0;
                    audioQuery.volumeScale     = config.volumeScale     ?? 1.0;
                } else {
                    if (DEBUG) {
                        console.log(`[DEBUG] ⏱️ RVC用自作無音区間の生成: ${audioQuery.postPhonemeLength}秒`);
                    }
                }

                // --- 2. VOICEVOX Synthesis (Query JSON -> WAV ArrayBuffer) ---
                if (DEBUG) {
                    console.log(`[処理中] RVC連携: ${item.label} をWAV化中...`);
                }

                // 第2引数を 'arraybuffer' にして共通関数を呼び出す！
                const voicevoxArrayBuffer = await fetchVoicevoxSynthesis(audioQuery, 'arraybuffer', k + 1, totalAllParts);

                // XHR管理のクリアとボタン状態の更新
                currentXhrs.length = 0;
                updateButtonState();

                // --- 3. RVC Conversion / Fallback ---
                let audioBlobToPlay = null;   // 再生用Blobを格納する変数をループ内で宣言
                let chunkResultBuffer = null; // 最終的に再生/キャッシュに使うArrayBuffer

                if (config.rvcEnabled && !rvcFailed) {
                    // RVC変換を試みる
                    try {
                        // `convertRvcAudioToArrayBuffer` を呼び出し、ArrayBufferを取得するわ
                        chunkResultBuffer = await requestRvcConversion(voicevoxArrayBuffer);
                        // ArrayBufferをBlobに変換して再生用変数に格納
                        audioBlobToPlay = new Blob([chunkResultBuffer,], { type: 'audio/wav', });
                    } catch (e) {
                        console.error('[RVC Conversion] RVC変換エラー発生:', e);
                        rvcFailed = true; // RVC失敗フラグ: 以降のチャンクはVOICEVOXのままにする

                        // 失敗したこのチャンクは、VOICEVOXオリジナル音声で再生
                        console.warn('[RVC Fallback] RVC変換に失敗したため、VOICEVOXのオリジナル音声で代替再生を試みます。');
                        audioBlobToPlay = new Blob([voicevoxArrayBuffer,], { type: 'audio/wav', });
                    }
                }

                // RVCがオフ、または失敗した場合はオリジナルを使用
                if (!audioBlobToPlay) {
                    audioBlobToPlay = new Blob([voicevoxArrayBuffer,], { type: 'audio/wav', });
                }

                // RVC変換が成功した場合のみ、キャッシュ用にArrayBufferを保持する
                if (chunkResultBuffer) {
                    successfulRvcBlobs.push(audioBlobToPlay);
                }

                // --- 4. Enqueue Playback ---
                await enqueueChunkForPlayback(audioBlobToPlay, k + 1, totalAllParts, cacheKey, isAutoPlay);
            }

            // --- 5. キャッシュ保存 ---
            if (!rvcFailed && successfulRvcBlobs.length > 0 && cacheKey) {
                const finalBlob = await connectWavBlobs(successfulRvcBlobs);
                await saveCache(cacheKey, finalBlob, 'RVC');
            }
        } catch (error) {
            // VOICEVOXのQueryやSynthesisの時点でエラーが発生した場合
            console.error('[VOICEVOX|RVC] 連携処理中に致命的なエラー発生:', error);
            const errorMessage = (typeof error === 'string') ? error : error.message;
            const shortErrorMessage = errorMessage.replace(/\s*\(Status:.*?\)/g, '');
            showToast(`😭 連携失敗: ${shortErrorMessage}`, false);
            stopPlayback(true); // エラー時は強制停止してボタンをリセットするわ
        }
    }

    // RVCサーバーに現在ロード中のモデルを問い合わせるAPI (infer_loaded_voice) を呼び出すわ
    async function getCurrentLoadedModel() {
        const statusUrl = `${config.rvcApiUrl.replace(/\/$/, '')}/run/infer_loaded_voice`;

        try {
            // GM_xmlhttpRequest は Promise を返さないので、手動でラップするわ
            const response = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: statusUrl,
                    data: JSON.stringify({
                        data: [],
                    }), // 引数は空でOKだけど、GradioのAPI形式に合わせるわ
                    headers: {
                        "Content-Type": "application/json",
                    },
                    responseType: 'json',
                    timeout: 5000, // 高速なAPIだからタイムアウトは短くて大丈夫よ
                    onload: (res) => resolve(res),
                    onerror: (err) => reject(new Error(err.responseText || 'Connection error')),
                    ontimeout: () => reject(new Error('Timeout while checking RVC status.')),
                });
            });

            // GradioのAPI応答形式: {data: [ {status: 'success', ...} ]} を想定
            if (response.status === 200 && response.response && response.response.data && response.response.data.length > 0) {
                const loadedInfo = response.response.data[0];

                if (loadedInfo && loadedInfo.status === 'success') {
                    const modelName = loadedInfo.model_file_name;
                    // 'Model Not Loaded' という静的な英語を null に変換するわ
                    return (modelName && modelName !== 'Model Not Loaded') ? modelName : null;
                }
            }
        } catch (error) {
            // 接続エラーやAPIエラー時は、安全のためロードを続行する（nullを返す）
            // console.warn('[RVC Check] ⚠️ モデル状態チェックAPIにアクセスできませんでした。エラー:', error.message);
        }
        return null;
    }

    /**
     * RVCモデルとインデックスをサーバーにロードする
     * @returns {Promise<boolean>} - ロードに成功した場合はtrue、失敗した場合はfalse
     */
    async function loadRvcModel() {
        if (!config.rvcEnabled) {
            return false;
        }

        const requiredModel = config.rvcModel;

        try {
            console.log(`[RVC Load] [${getFormattedDateTime()}] 🔍 現在ロード中のモデルをチェック中...`);
            const loadedModel = await getCurrentLoadedModel();

            if (loadedModel === requiredModel) {
                // 🚀 ロードをスキップ！
                console.log(`[RVC Load] [${getFormattedDateTime()}] ✅ モデル '${requiredModel}' は既にロードされています。ロードをスキップします。`);
                return true; // 処理完了
            } else if (loadedModel) {
                // 別のモデルがロードされているので、ロード処理（infer_change_voice）に進む
                console.log(`[RVC Load] [${getFormattedDateTime()}] 🔄 別のモデル ('${loadedModel}') がロードされています。'${requiredModel}' に切り替えます...`);
            } else {
                // モデルが何もロードされていないので、ロード処理に進む
                console.log(`[RVC Load] [${getFormattedDateTime()}] 🤖 モデル '${requiredModel}' をロードします...`);
            }
        } catch (e) {
            console.error('[RVC Load] ❌ ロードチェック中に予期せぬエラー。ロードを強制実行します:', e);
            // エラー時はフォールバックとして、そのままロード処理に進ませるわ
        }

        // 1. ロード中なら待機（排他制御）
        while (isRvcModelLoading) {
            // 処理が重ならないように前の処理が終わるまで待つ
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // 2. ロード開始
        isRvcModelLoading = true;

        const loadUrl = `${config.rvcApiUrl.replace(/\/$/, '')}/run/infer_change_voice`;

        try {
            const loadPromise = new Promise((resolve, reject) => {
                const rvcRequestBody = {
                    data: [
                        requiredModel,             // 0. RVC モデルファイルパス
                        config.rvcArtefact, // 1. rvcArtefact
                        config.rvcArtefact, // 2. rvcArtefact
                    ],
                };

                const xhr = GM_xmlhttpRequest({
                    method: 'POST',
                    url: loadUrl,
                    data: JSON.stringify(rvcRequestBody),
                    headers: {
                        "Content-Type": "application/json",
                    },
                    responseType: 'json',
                    timeout: 30000, // モデルロードなので長めに30秒
                    onload: (response) => {
                        if (response.status === 200) {
                            // console.log(`[RVC Load] ✅ モデル '${requiredModel}' のロードとキャッシュが完了したわ！`, response.response);
                            resolve();
                        } else {
                            reject(`RVCモデルロード失敗 (Status: ${response.status} / Response: ${JSON.stringify(response.response)})`);
                        }
                    },
                    onerror: () => reject('RVCモデルロード 接続エラー'),
                    ontimeout: () => reject('RVCモデルロード タイムアウト (サーバーが応答しないかも)'),
                });
            });

            await loadPromise;
            console.log(`[RVC Load] [${getFormattedDateTime()}] 🤖 モデル '${requiredModel}' のロードが完了しました。`);
            return true;

        } catch (error) {
            const errorMessage = (typeof error === 'string') ? error : (error.message || '不明なエラー');
            const shortErrorMessage = errorMessage.replace(/\s*\(Status:.*?\)/g, '');
            console.error('[RVC Load] ❌ モデルロード中にエラー発生:', error);
            return false;
        } finally {
            isRvcModelLoading = false;
        }
    }

    /**
     * VOICEVOX連携の処理（audio_query -> synthesis -> playAudio）
     * ストリーミング再生（Web Audio API）を優先しつつ、失敗時はBlob結合による一括再生にフォールバックするわ。
     * @param {string} text - 合成するテキスト
     * @param {boolean} isAutoPlay - 自動再生フラグ
     * @param {string} cacheKey - 生成されたキャッシュキー
     */
    async function synthesizeVoicevoxAudio(text, isAutoPlay, cacheKey) {
        // 1. 分割
        const MAX_CHUNK_LENGTH = config.chunkSize || DEFAULT_CHUNK_SIZE;
        let chunks = splitTextForSynthesis(text, MAX_CHUNK_LENGTH);

        // 2. 最大チャンク数制限
        if (chunks.length > config.maxChunks) {
            chunks = chunks.slice(0, config.maxChunks);
            chunks.push("。……。指定の分割数を超えたため、読み上げを終了したわ。");
            showToast(`最大チャンク数(${config.maxChunks})を超えたため、制限をかけたわよ。`, false);
        }

        if (chunks.length === 0) {
            showToast('合成する有効なテキストがないわ。', false);
            return;
        }

        isConversionAborted = false;

        // フォールバックのために、合成された音声Blobを格納する配列を復活させるわ！
        const audioBlobs = [];

        // すべてのテキストと無音を、1つの「フラットな全サブクエリ配列」にまとめあげるわ！
        const allSubQueries = buildAllSubQueries(chunks);

        // 本当の総パーツ数（通し番号の最大値）
        const totalAllParts = allSubQueries.length;

        try {
            // ストリーミング再生を初期化
            initStreamingPlayback(isAutoPlay);

            for (let k = 0; k < totalAllParts; k++) {
                const item = allSubQueries[k];
                let audioQuery = item.query;

                if (isConversionAborted) {
                    console.log('[SYNTH] 合成中断要求が確認されたわ。ループを終了するわね。');
                    throw new Error('Synthesis Aborted by User Request');
                }

                // 進捗ログ
                if (!isPlaying) {
                    showToast(`WAVデータを生成中... （${item.textLength}/${text.length}文字）[${k + 1}/${totalAllParts}]`, null);
                }
                console.log(`[VOICEVOX|RVC] [${getFormattedDateTime()}] WAVデータを生成中... （${item.textLength}/${text.length}文字）[${k + 1}/${totalAllParts}]`);

                // --- 1. Audio Query の取得 / パラメータ適用 ---
                if (item.type === 'text') {
                    audioQuery = await fetchVoicevoxQuery(item.text, k + 1, totalAllParts);

                    audioQuery.speedScale      = config.speedScale      ?? 1.0;
                    audioQuery.pitchScale      = config.pitchScale      ?? 0.0;
                    audioQuery.intonationScale = config.intonationScale ?? 1.0;
                    audioQuery.volumeScale     = config.volumeScale     ?? 1.0;

                    if (DEBUG) {
                        const kanaYomi = audioQuery.accent_phrases.flatMap(phrase => phrase.moras.map(mora => mora.text)).join('');
                        console.log(`[DEBUG] 🗣️ audio_query通過後の読み: ${kanaYomi}`);
                    }
                } else {
                    if (DEBUG) {
                        console.log(`[DEBUG] ⏱️ 自作無音区間の生成: ${audioQuery.postPhonemeLength}秒`);
                    }
                }

                // --- 2. Voice Synthesis (音声合成) ---
                if (DEBUG) {
                    console.log(`[処理中] ${item.label} をWAV化して再生キューに送るわよ`);
                }

                const chunkBlob = await fetchVoicevoxSynthesis(audioQuery, 'blob', k + 1, totalAllParts);

                // XHR管理のクリーンアップとUI更新
                currentXhrs.length = 0;
                updateButtonState();

                audioBlobs.push(chunkBlob); // キャッシュ・フォールバック用に保持

                // --- 3. Enqueue Playback (再生キュー登録) ---
                await enqueueChunkForPlayback(chunkBlob, k + 1, totalAllParts, cacheKey, isAutoPlay);
            }

            // --- 4. 結合・キャッシュ保存・Playback（フォールバックとキャッシング） ---
            const finalAudioBlob = await connectWavBlobs(audioBlobs); // 結合処理

            if (cacheKey) {
                await saveCache(cacheKey, finalAudioBlob, 'VOICEVOX');
            }

            // ストリーミング再生ができない、または失敗した場合のフォールバック処理！
            if (!audioContext || !isPlaying) { // isPlayingがfalseなら、ストリーミングが中断された可能性があるわ
                // AudioContextが使えない、または途中でエラーになった場合（フォールバック！）
                showToast('😭 ストリーミング再生に失敗したわ... 全体の結合を開始するわね！', false);
                console.log('[Fallback] ストリーミング失敗。Blob結合に切り替えるわ。');
                // Playback
                const successMessage = isAutoPlay ? '🔊 WAVデータの取得に成功したわ！音声再生中よ！' : '✅ 音声データの準備完了！再生ボタンを押してね。';
                await playAudio(finalAudioBlob, 0, successMessage);
            }
        } catch (error) {
            if (error.message?.includes('Aborted')) {
                console.log('[SYNTH] ユーザーによる中断を正常に処理したわ。');

                const errorMessage = (typeof error === 'string') ? error : error.message;
                const isInternalError = errorMessage.includes('Status: 500');
                let shortErrorMessage = errorMessage.replace(/\s*\(Status:.*?\)/g, '');
                if (isInternalError) {
                    shortErrorMessage = `致命的エラー (500)！メモリ不足の可能性あり。長文合成のチャンクサイズを${DEFAULT_CHUNK_SIZE}文字以下に調整してみて！`;
                }
                showToast(`😭 連携失敗: ${shortErrorMessage}`, false);

                await stopPlayback(true);
            } else {
                throw error; // startConversion の catch に渡す
            }
        }
    }

    /**
     * 長文をVOICEVOXの制約に合わせ、句読点を考慮して分割するわ！
     * @param {string} text - 分割前のテキスト
     * @param {number} maxChunkLength - チャンクの最大文字数（例: 300）
     * @returns {string[]} - 分割されたテキストの配列
     */
    function splitTextForSynthesis(text, maxChunkLength) {
        // [pause:n] を一時的に安全な形式に変換するわ
        let protectedText = text.replace(/\[pause:(\d+(?:\.\d+)?)\]/g, '::$1::');

        // 1. 分割文字 [\n。？！、,.?!；;]  <- 日本語の句読点 ＋ 英語の句読点 ＋ セミコロン
        // \s*: 空白文字が0回以上続くことを許可（行頭の空白などに対応）
        const segments = protectedText.split(/(\s*[\n。？！、,.?!；;])/);

        let chunks = [];
        let currentChunk = "";

        // 2. 分割されたピースを結合し、文字数制限をかけるわ
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (!segment || segment.trim() === "") {
                continue;
            }

            // 次のセグメントを結合すると最大長を超えるかチェック
            // ただし、currentChunkが空の場合は、そのセグメント自体が長すぎるかチェック
            if (currentChunk.length + segment.length > maxChunkLength && currentChunk.length > 0) {
                // 現在のチャンクを確定して新しいチャンクを開始
                chunks.push(currentChunk.trim());
                currentChunk = segment;
            } else {
                // 結合するか、新しいチャンクとして開始
                currentChunk += segment;
            }
        }

        // 3. 最後に残ったチャンクを追加
        if (currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
        }

        // 最後に、分割された各チャンクの中で `::1::` を元の `[pause:1]` に戻すわ！
        const restoredChunks = chunks.map(chunk => {
            return chunk.replace(/::(\d+(?:\.\d+)?)::/g, '[pause:$1]');
        });

        return restoredChunks;
    }

    /**
     * テキストからすべてのサブクエリ（通常セリフ・自作無音）のフラットな配列を構築する共通関数
     * @param {string[]} chunks - 分割済みのテキストチャンク配列
     * @param {Object} config - 設定オブジェクト
     * @returns {Object[]} フラット化されたサブクエリデータの配列
     */
    function buildAllSubQueries(chunks) {
        const allSubQueries = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            // 送信直前の生チャンクのDEBUGログ
            if (DEBUG) {
                const pauseTimes = [];
                const voicevoxText = chunk.replace(/\[pause:(\d+(?:\.\d+)?)\]/g, (match, p1) => {
                    pauseTimes.push(parseFloat(p1));
                    return '＿';
                });
                console.log(`[DEBUG] 送信直前の生チャンク [${i + 1}/${chunks.length}]: "${chunk}"`);
                console.log(`[DEBUG] 置換後のVOICEVOXテキスト: "${voicevoxText}"`);
            }

            const subParts = chunk.split(/\[pause:(\d+(?:\.\d+)?)\]/g);

            for (let j = 0; j < subParts.length; j++) {
                const part = subParts[j];
                if (!part) {
                    continue;
                } // 空文字スキップ

                if (j % 2 === 1) {
                    // 無音区間の生成
                    const seconds = parseFloat(part);
                    const blankQuery = {
                        "accent_phrases": [{
                            "moras": [],
                            "accent": 0,
                            "pause_mora": {
                                "text": "",
                                "consonant": null,
                                "consonant_length": null,
                                "vowel": "pau",
                                "vowel_length": 0.0,
                                "pitch": 0,
                            },
                            "is_interrogative": false,
                        },],
                        "speedScale": 1.0,
                        "pitchScale": 0.0,
                        "intonationScale": 1.0,
                        "volumeScale": 0.0,
                        "prePhonemeLength": 0.0,
                        "postPhonemeLength": seconds, // ここに指定された秒数を寸分の狂いなく代入！
                        "pauseLength": 0.0,
                        "pauseLengthScale": 1.0,
                        "outputSamplingRate": 24000,
                        "outputStereo": false,
                        "kana": "",
                    };
                    allSubQueries.push({
                        type: 'pause',
                        query: blankQuery,
                        label: `無音区間: ${seconds}秒`,
                        textLength: chunk.length, // トーストの文字数表示用
                        rawText: part,
                    });
                } else {
                    // 通常のテキスト部分
                    allSubQueries.push({
                        type: 'text',
                        text: part,
                        label: `セリフ: "${part.substring(0, 10)}..."`,
                        textLength: chunk.length,
                        rawText: part,
                    });
                }
            }
        }
        return allSubQueries;
    }

    /**
     * VOICEVOXのaudio_queryを実行してクエリJSONを取得する
     */
    async function fetchVoicevoxQuery(text, currentPart, totalParts) {
        return new Promise((resolve, reject) => {
            const queryParams = new URLSearchParams({ text: text, speaker: config.speakerId, });
            const xhr = GM_xmlhttpRequest({
                method: 'POST',
                url: `${config.apiUrl}/audio_query?${queryParams.toString()}`,
                headers: { 'Content-Type': 'application/json', },
                timeout: VOICEVOX_TIMEOUT_MS,
                onload: (res) => {
                    currentXhrs = currentXhrs.filter(x => x !== xhr);
                    if (res.status === 200) {
                        resolve(JSON.parse(res.responseText));
                    } else {
                        reject(`VOICEVOX Query 失敗 (Status: ${res.status}) (${currentPart}/${totalParts})`);
                    }
                },
                onerror: () => {
                    currentXhrs = currentXhrs.filter(x => x !== xhr); reject(`VOICEVOX Query 接続エラー (${currentPart}/${totalParts})`);
                },
                ontimeout: () => {
                    currentXhrs = currentXhrs.filter(x => x !== xhr); reject(`VOICEVOX Query タイムアウト (${currentPart}/${totalParts})`);
                },
            });
            currentXhrs.push(xhr);
        });
    }

    /**
     * VOICEVOXのsynthesisを実行して音声データを取得する（responseTypeを指定可能にする）
     * @param {Object} audioQuery - クエリJSON
     * @param {string} responseType - 'blob' または 'arraybuffer'
     */
    async function fetchVoicevoxSynthesis(audioQuery, responseType, currentPart, totalParts) {
        return new Promise((resolve, reject) => {
            const xhr = GM_xmlhttpRequest({
                method: 'POST',
                url: `${config.apiUrl}/synthesis?speaker=${config.speakerId}`,
                headers: { 'Content-Type': 'application/json', },
                data: JSON.stringify(audioQuery),
                responseType: responseType, // RVCは'arraybuffer'、通常は'blob'を流せるように汎用化！
                timeout: VOICEVOX_TIMEOUT_MS,
                onload: (res) => {
                    currentXhrs = currentXhrs.filter(x => x !== xhr);
                    if (res.status === 200 && res.response) {
                        resolve(res.response);
                    } else {
                        reject(`VOICEVOX Synthesis 失敗 (Status: ${res.status}) (${currentPart}/${totalParts})`);
                    }
                },
                onerror: () => {
                    currentXhrs = currentXhrs.filter(x => x !== xhr); reject(`VOICEVOX Synthesis 接続エラー (${currentPart}/${totalParts})`);
                },
                ontimeout: () => {
                    currentXhrs = currentXhrs.filter(x => x !== xhr); reject(`VOICEVOX Synthesis タイムアウト (${currentPart}/${totalParts})`);
                },
            });
            currentXhrs.push(xhr);
        });
    }

    /**
     * 結合された音声データ(Blob)をBase64に変換し、Tampermonkeyのストレージにキャッシュとして保存するわ。
     * VOICEVOXとRVCの両方から呼び出せるようにするわ。
     * @param {string} cacheKey - キャッシュのキーとして使うハッシュ値
     * @param {Blob} finalBlob - 結合された最終的なWAV音声データ (Blob)
     * @param {string} source - キャッシュ元 ('VOICEVOX' または 'RVC')
     */
    async function saveCache(cacheKey, finalBlob, source) {
        // BlobをData URL (Base64) に変換するわ（VOICEVOX側で使っていた処理をそのまま使うわ）
        const base64WavData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = function() {
                // Data URL (例: data:audio/wav;base64,...) を返すわ
                resolve(reader.result);
            };
            reader.onerror = reject;
            reader.readAsDataURL(finalBlob);
        });

        // キャッシュを保存！
        GM_setValue(LAST_CACHE_HASH, cacheKey);
        GM_setValue(LAST_CACHE_DATA, base64WavData);

        updateDownloadButtonState(); // 保存直後にダウンロードボタンをONにする
        console.log(`[Cache] 💾 ${source}音声をキャッシュに保存したわ！ (Key: ${cacheKey.substring(0, 50)}...)`);
    }

    // キャッシュキーを生成する関数
    function generateCacheKey(text) {
        // VVとRVCで共通の必須キー（textとspeakerIdが同じなら、VOICEVOXの素の音声は同じになる）
        const keyParts = [
            text,
            config.speakerId,
            config.rvcEnabled ? 'RVC' : 'VV', // VVかRVCかを識別
        ];

        // 共通のVOICEVOXパラメーターをキーに追加
        // （configにVOICEVOXの音量, 速度, ピッチ調整UIが将来追加されることを想定）
        // 現在はUIがないため、デフォルト値（未設定）が使われるが、将来対応のための布石。
        keyParts.push(
            config.speedScale || 1.0,      // 速度
            config.pitchScale || 0.0,      // ピッチ
            config.intonationScale || 1.0, // 抑揚
            config.volumeScale || 1.0      // 音量
        );

        // RVCが有効な場合のみ、RVCの全設定パラメータをキーに追加
        if (config.rvcEnabled) {
            // ... (RVCの全パラメータを push するロジックは省略せずに継続) ...
            keyParts.push(
                config.rvcModel || '',
                config.rvcIndex || '',
                config.rvcPitch || 0,
                config.rvcRatio || 0.75,
                config.rvcAlgorithm || 'rmvpe',
                config.rvcResample || 48000,
                config.rvcNumber || 0,
                config.rvcEnvelope || 0.25,
                config.rvcArtefact || 0.33,
                config.rvcMedianFilter || 3
            );
        }

        // JSON文字列化、Base64エンコードしてキーとして返す
        const hash = JSON.stringify(keyParts);
        const encodedHash = encodeURIComponent(hash);
        return 'audio_cache_' + btoa(encodedHash).replace(/=+$/, '');
    }

    /*
     * キャッシュされたBase64データを再生する関数
     * Blob変換ロジックを再利用し、新しいplayAudioに処理を移譲するわ。
     * 成功時に true、失敗時に false を返す
     */
    async function playCachedAudio(base64WavData) {
        stopPlayback(true);

        try {
            // Base64 URIからBlobオブジェクトを生成する
            const cachedBlob = base64UriToBlob(base64WavData, 'audio/wav');
            // playAudioに渡すメッセージを設定（自動再生ブロック時はplayAudio内で別のメッセージに変わる）
            const successMessage = '🔊 キャッシュから再生するよ♪';
            // 新しい playAudio 関数を呼び出す！
            await playAudio(cachedBlob, 0, successMessage);
            return true;
        } catch (e) {
            // Blob生成でエラーが発生した場合（キャッシュデータが壊れている）
            GM_deleteValue(LAST_CACHE_HASH);
            GM_deleteValue(LAST_CACHE_DATA);
            console.error('[Cache Playback] Blob生成エラー:壊れたキャッシュデータを削除し、状態をリセットしました。再合成を試みます。', e);
            stopPlayback(true); // エラー時は状態をリセット
            return false;
        }
    }

    // キャッシュクリア
    async function clearCached() {
        // 1. Tampermonkeyのストレージから、キャッシュのハッシュと音声データを削除するわ
        GM_deleteValue(LAST_CACHE_HASH);
        GM_deleteValue(LAST_CACHE_DATA);

        // 2. キャッシュが消えたので、ダウンロードボタンの状態を更新して無効化するわよ
        if (typeof updateDownloadButtonState === 'function') {
            updateDownloadButtonState();
        }

        // 3. 撮影の目安になるようにトーストを表示
        showToast('🗑️ キャッシュを削除したよ！', false);
        console.log('[Cache] 🗑️ キャッシュクリア完了（これで次の再生で文字数トーストが出るわよ）');
    }

    // メインの再生のトリガー
    async function startConversion(isAutoPlay = false) {
        // 物理的な「実態」をチェックするわよ
        const isAuto = (isAutoPlay === true);

        if (DEBUG) {
            console.log(`[Debug] Mode:${isAuto ? 'AUTO' : 'MANUAL'}, Synth:${isConversionStarting}, Play:${isPlaying}, Audio:${audioContext?.state}`);
        }

        if (isAuto) {
            if (DEBUG) {
                console.log('[Debug] 自動再生の割り込み。強制的に全停止して更地にするわよ。');
            }

            // ループ中断フラグを即座に立てる（重要：awaitの前に立てる！）
            isConversionAborted = true;
            // 前の再生や合成を完全に止める（awaitで完了を待つ）
            await stopPlayback(true);

            // 完全に掃除が終わってからフラグリセット
            isConversionAborted = false;
        } else {
            // 手動時：Synth か Play が本当のビジー状態
            if (isConversionStarting || isPlaying) {
                showToast('今は再生中よ。停止ボタンで止めてから次の操作をしてね。', false);
                return;
            }
            // AudioContext が残っているだけなら、ここで掃除を試みる
            if (audioContext && audioContext.state !== 'closed') {
                console.log('[Debug] 古い AudioContext を掃除して開始するわ。');
                await stopPlayback(true);
            }
        }

        // 一時停止
        if (isPause) {
            isPause = false;
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume();
            }
            return;
        }

        console.log(`[VOICEVOX|RVC] [${getFormattedDateTime()}] Geminiの回答を取得中...`);
        let text = responseAnswerText();
        if (!text || text.trim() === '') {
            showToast('回答テキストが取得できなかったか、全て除去されたわ...', false);
            return;
        }

        if (isAutoPlay) {
            lastAutoPlayedText = text; // 自動再生の場合、次回以降の自動再生を抑止
        }

        console.log(`[SYNTH] 読み上げテキスト（${text.length}文字）: ${text.substring(0, 50)}...`);

        // キャッシュチェック
        const requestCacheKey = generateCacheKey(text);
        const cachedHash = GM_getValue(LAST_CACHE_HASH, null);

        if (requestCacheKey === cachedHash) {
            const cachedData = GM_getValue(LAST_CACHE_DATA, null); // Base64 URI
            if (cachedData) {
                console.log(`[Cache] ✅ キャッシュヒット！即時再生を試みます！`);
                const success = await playCachedAudio(cachedData); // キャッシュ再生関数を呼び出す
                if (success) {
                    return; // 成功したらここで終了よ
                }
            }
        }

        isConversionStarting = true; // 「合成中」開始フラグ
        updateButtonState();

        try {
            if (config.rvcEnabled) {
                await synthesizeRvcAudio(text, isAutoPlay, requestCacheKey);
            } else {
                await synthesizeVoicevoxAudio(text, isAutoPlay, requestCacheKey);
            }
        } catch (error) {
            // RVC/VOICEVOXの内部処理でハンドルされなかった、予期せぬ致命的なエラーをキャッチ
            console.error('[SYNTHESIS_FATAL_ERROR] 予期せぬ合成処理エラー:', error);
            const shortMessage = (typeof error === 'string') ? error : (error.message || '不明なエラー');
            showToast(`😭 致命的な合成エラー: ${shortMessage.substring(0, 30)}...`, false);
            await stopPlayback(true); // XHRを確実に中止して状態をリセットするわ！
        } finally {
            isConversionStarting = false; // 処理終了時（成功・失敗問わず）にフラグをリセット
            isConversionAborted = false;
            updateButtonState();
        }
    }

    /**
     * ストリーミング再生を開始するための初期設定を行うわ。
     * @param {boolean} isAutoPlay - 自動再生フラグ
     */
    function initStreamingPlayback(isAutoPlay) {
        // Web Audio APIのコンテキストを作成・再利用するわ。
        if (!audioContext) {
            // NOTE: ブラウザによってWebkitを使う場合があるわ
            audioContext = new(window.AudioContext || window.webkitAudioContext)();
        }

        // 状態をリセットするわ。
        nextStartTime = 0;
        totalStreamingChunks = 0;
        finishedStreamingChunks = 0;
        currentStreamingCacheKey = null;

        // AudioContextが動いているか確認するわ。（一時停止中の場合もあるわ）
        if (audioContext && audioContext.state === 'suspended') {
            // ユーザーの操作待ちなら、再開を試みるわ。
            audioContext.resume().catch(e => console.warn('[Streaming] 📢 AudioContextの再開に失敗したわ:', e));
        }

        // 音声が再生されることをユーザーに知らせるわ！
        if (isAutoPlay && audioContext) { // AudioContextが使えそうなら期待させるわ
            // showToast('WAVデータの合成が完了次第、ストリーミング再生を開始するわ！', true);
        } else if (isAutoPlay) {
            // AudioContextが使えない場合は、フォールバック（結合再生）に期待するわ
            // showToast('ストリーミング再生は難しいみたい。WAV結合後に再生するわね！', true);
        }
    }

    /**
     * 合成された音声チャンク（Blob）をRVC変換し、Web Audio APIのキューに追加し、再生するわ。
     * @param {Blob} chunkBlob - 合成された音声のBlobデータ（VOICEVOXオリジナル）
     * @param {number} chunkIndex - 現在のチャンクのインデックス（1始まり）
     * @param {number} totalChunks - 全体のチャンク数
     * @param {string} cacheKey - キャッシュキーのベース
     * @param {boolean} isAutoPlay - 自動再生フラグ
     */
    async function enqueueChunkForPlayback(playableBlob, chunkIndex, totalChunks, cacheKey, isAutoPlay) {
        // AudioContextが使えないなら何もしないわ（フォールバックに任せるわよ！）
        if (!audioContext || audioContext.state === 'closed' || isConversionAborted) {
            return;
        }

        // Autoplay Policy 解除のための resume() 処理を追加！
        if (audioContext.state === 'suspended') {
            // 【重要】await を外し、ブロックさせずに処理を続行するわ！
            audioContext.resume().catch(e => {
                // 再開に失敗したらログだけ出すわ
                console.error("[AudioContext] ❌ resumeに失敗:", e);
                // ここで catch されたとしても、AudioContext の状態は変わらないわ。
            });
        }

        // トータルチャンク数を記録するわ！
        totalStreamingChunks = totalChunks;

        try {
            // BlobをArrayBufferに変換するわ
            const arrayBuffer = await playableBlob.arrayBuffer();

            // ArrayBufferをAudioBufferにデコードするわ（非同期処理）
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

            // 待っている間に手動停止されてたら即座に終了するわ！
            if (isConversionAborted || !audioContext) {
                return;
            }

            // 再生ノードを作成し、キューに追加するわ
            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContext.destination);

            // 再生開始時刻を計算し、キューに追加するわ
            // nextStartTimeが初期値(0)か、AudioContextの現在時刻より過去なら、現在の時刻から再生を開始するわ！
            if (chunkIndex === 1 || nextStartTime === 0 || nextStartTime < audioContext.currentTime) {
                nextStartTime = audioContext.currentTime;
            }

            // 最初のチャンクが再生される直前に、状態を「再生中」にする
            if (!isPlaying && audioContext.state === 'running') {
                showToast('🔊 素敵な声で再生スタートよ！', true);
                isPlaying = true;
                updateButtonState(); // ボタンを「停止」に切り替えるわ！
            } else if (audioContext.state !== 'running') {
                isPause = true;
                showToast(`✋🏻 自動再生ブロック。再生ボタンを手動で押してね！`, false);
                updateButtonState();
            }

            // 再生開始時刻を設定し、再生！
            source.start(nextStartTime);
            currentSourceNode = source; // 停止処理のために記録しておくわ

            // 次のチャンクの開始時刻を更新するわ。
            nextStartTime += audioBuffer.duration;

            console.log(`[Streaming] 🔊 チャンク ${chunkIndex}/${totalChunks} を ${nextStartTime.toFixed(2)}秒後にキューイングしたわ。`);

            // 再生が終了したらメモリを解放するコールバックを設定するわ！
            source.onended = () => {
                source.disconnect();
                finishedStreamingChunks++; // 再生完了チャンク数を増やすわ

                // 全てのチャンクの再生が終わったら、ボタンをリセットするわ！
                if (finishedStreamingChunks === totalStreamingChunks) {
                    isPlaying = false;
                    updateButtonState(); // ボタンを最終状態（合成完了後なら「再生」）に戻すわ！
                }
            };
        } catch (e) {
            console.error('[Streaming] ❌ チャンク処理失敗:', e);
            // デコード失敗は致命的だけど、合成自体は続行させるわ。
            showToast(`😭 チャンク ${chunkIndex}/${totalChunks} の処理に失敗したわ。`, false);
            // ... チャンクが失敗した場合の処理（ここではスキップとして扱うわ）
            finishedStreamingChunks++;
            if (finishedStreamingChunks === totalStreamingChunks) {
                isPlaying = false;
                updateButtonState();
            }
        }
    }

    /**
     * 複数のWAV Blobを一つに結合するわ。
     * WAVファイルのヘッダーを解析し、データ部分を連結し、最終的なヘッダーサイズを再計算するの！
     * @param {Blob[]} blobs - 結合するWAV Blobの配列
     * @returns {Promise<Blob>} - 結合された単一のWAV Blob
     */
    async function connectWavBlobs(blobs) {
        if (!blobs || blobs.length === 0) {
            return new Blob([]);
        }
        if (blobs.length === 1) {
            return blobs[0];
        }

        // 全てのBlobをArrayBufferに変換
        const buffers = await Promise.all(blobs.map(blob => blob.arrayBuffer()));

        const firstBuffer = buffers[0];
        const dataView = new DataView(firstBuffer);

        // RIFFヘッダーから'data'チャンクの開始位置を特定
        let dataOffset = -1;
        let offset = 12; // サブチャンクは12バイト目から始まる
        while (offset < firstBuffer.byteLength) {
            const chunkId = dataView.getUint32(offset, false);
            const chunkSize = dataView.getUint32(offset + 4, true);

            if (chunkId === 0x64617461) { // 'data' chunk ID
                dataOffset = offset + 8;
                break;
            }

            offset += 8 + chunkSize + (chunkSize % 2);
        }

        if (dataOffset === -1) {
            throw new Error("WAVデータチャンクが検出できないわ。結合できない！");
        }

        // 全てのdataチャンクを結合
        let totalDataSize = 0;
        const dataChunks = [];

        for (const buffer of buffers) {
            const dv = new DataView(buffer);
            let currentOffset = 12;

            while (currentOffset < buffer.byteLength) {
                const chunkId = dv.getUint32(currentOffset, false);
                const chunkSize = dv.getUint32(currentOffset + 4, true);

                if (chunkId === 0x64617461) { // 'data' chunk ID
                    dataChunks.push(buffer.slice(currentOffset + 8, currentOffset + 8 + chunkSize));
                    totalDataSize += chunkSize;
                    break;
                }

                currentOffset += 8 + chunkSize + (chunkSize % 2);
            }
        }

        // 新しいバッファを作成し、ヘッダーと結合データを入れる
        const headerBeforeData = firstBuffer.slice(0, dataOffset);
        const finalBuffer = new ArrayBuffer(headerBeforeData.byteLength + totalDataSize);
        const finalView = new DataView(finalBuffer);

        // ヘッダー部をコピー
        new Uint8Array(finalBuffer).set(new Uint8Array(headerBeforeData));

        // RIFFチャンクサイズを更新（全体サイズ - 8バイト）
        const newRiffSize = headerBeforeData.byteLength + totalDataSize - 8;
        finalView.setUint32(4, newRiffSize, true);

        // 'data'チャンクサイズを更新
        finalView.setUint32(dataOffset - 4, totalDataSize, true);

        // 結合データ部分をコピー
        let finalDataOffset = headerBeforeData.byteLength;
        for (const dataChunk of dataChunks) {
            new Uint8Array(finalBuffer).set(new Uint8Array(dataChunk), finalDataOffset);
            finalDataOffset += dataChunk.byteLength;
        }

        return new Blob([finalBuffer,], {
            type: 'audio/wav',
        });
    }

    /**
     * WAV/MP3データを再生するわ。自動再生ポリシーに引っかかった場合、最大3回まで再試行するわよ！
     * @param {Blob} blob - 再生する音声データのBlobオブジェクト
     * @param {number} retryCount - 現在のリトライ回数（内部処理用。通常は0で呼び出す）
     */
    async function playAudio(blob, retryCount = 0, successMessage) {
        const RETRY_DELAY_MS = 300; // リトライ間隔は300ms
        if (retryCount > 0) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
        // 初回呼び出し時に古い再生を停止する
        if (retryCount === 0) {
            stopPlayback(true);
        }

        const audioUrl = URL.createObjectURL(blob);
        currentAudio = new Audio(audioUrl);

        // 再生終了時の処理（Promiseでラップして await で待機するわ）
        const audioEndedPromise = new Promise(resolve => {
            const audioEndedListener = () => {
                currentAudio.removeEventListener('ended', audioEndedListener);
                resolve('ended');
            };
            currentAudio.addEventListener('ended', audioEndedListener);
        });

        // フラグとボタンの状態を更新（再生開始時のみ）
        if (retryCount === 0) {
            isPlaying = true;
            updateButtonState();
        }

        try {
            await currentAudio.play();

            // 再生成功！
            console.log(`[VOICEVOX|RVC] [${getFormattedDateTime()}] 再生に成功したわ！`);
            if (retryCount > 0) {
                showToast('🎉 再生に成功したわ！', true);
            } else {
                showToast(successMessage, true); // 初回成功時は引数のメッセージ
            }

            // 再生終了を待つ
            await audioEndedPromise;

        } catch (error) {
            // 再生失敗時 (NotAllowedError: play() failed)
            console.error('[VOICEVOX] 音声再生に失敗したわ:', error);

            // リトライ回数を確認
            if (retryCount < MAX_RETRY_COUNT) {
                // まだリトライ可能
                const nextRetryCount = retryCount + 1;
                showToast(`❌ 再生失敗... リトライするわ！ (${nextRetryCount}/${MAX_RETRY_COUNT})`, false);

                // Audioオブジェクトのクリーンアップ（重要！）
                URL.revokeObjectURL(audioUrl);
                currentAudio = null;
                return playAudio(blob, nextRetryCount, '');
            } else {
                // 最大リトライ回数を超えた
                console.error('[VOICEVOX] 最大リトライ回数を超えたから、再生を諦めるわ。');
                showToast(`✋🏻 自動再生ブロック。再生ボタンを手動で押してね！`, false);
                isConversionStarting = false;
            }
        } finally {
            // 再生が成功して終わった、またはリトライ失敗で終わった場合に実行
            // イベントリスナーとオブジェクトをクリーンアップ
            URL.revokeObjectURL(audioUrl); // メモリ解放

            // 状態をリセット
            isPlaying = false;
            updateButtonState();
            currentAudio = null;
        }
    }

    async function resumeContext() {
        if (DEBUG) {
            console.log(`[Debug] resumeContextを開始: 現在の状態: ${audioContext?.state}`);
        }

        if (!audioContext) {
            return;
        }

        try {
            // ⏳ 重要: ブラウザが完全にロックを解除して「running」状態になるのをきっちり待つ！
            await audioContext.resume();

            if (DEBUG) {
                console.log(`[Debug] resume完了後の状態: ${audioContext.state}`);
            }

            // 状態が完全に「running」になってから、フラグを安全に書き換える
            isPause = false;
            isPlaying = true;

            // ボタンの表示を「停止」に更新
            updateButtonState();
            showToast('🔊 再生開始！素敵な声が聞こえてくるわ！', true);
        } catch (error) {
            console.error('[RVC] AudioContextの再開に失敗したわ:', error);
        }
    }

    /**
     * 再生中の全てのアクションを停止するわ。（合成の中止を含む）
     * @param {boolean} [silent=false] - trueの場合、停止トーストを表示しないわ。
     */
    async function stopPlayback(silent = false) {
        // 1. 引数の正規化（イベントオブジェクト対策）
        if (typeof silent === 'object' && silent !== null) {
            silent = false;
        }

        // 現在の状態を判定
        const isCurrentlyConverting = isConversionStarting || (currentXhrs.length > 0);

        // 2. 合成中の場合のみ必要なフラグ立て
        if (isCurrentlyConverting) {
            isConversionAborted = true;
        }

        // 3. 共通のリセット処理（XHR中断やHTML Audio停止、ボタン状態リセットなど）
        // resetOperationの中で isPlaying のリセットなども行われる前提
        resetOperation(!silent);

        // 4. AudioContext のクローズ処理（共通化してスッキリ！）
        if (audioContext && audioContext.state !== 'closed') {
            try {
                // ここで await して確実にクローズを待つ
                await audioContext.close();
                console.log(`[Streaming] AudioContext を正常にクローズしたわ。${silent ? '（silent）' : ''}`);
            } catch (e) {
                console.error('[Streaming] AudioContext クローズ失敗:', e);
            } finally {
                // 成功しても失敗しても、変数は必ず掃除するわ！
                audioContext = null;
                currentSourceNode = null;
                nextStartTime = 0;
                finishedStreamingChunks = 0;
                totalStreamingChunks = 0;
                currentStreamingCacheKey = null;
            }
        }
    }

    /**
     * ダウンロードボタンの状態（有効/無効）を、現在の回答とキャッシュの整合性に基づいて更新するわ。
     */
    function updateDownloadButtonState() {
        const dlButton = document.getElementById('downloadButton');
        if (!dlButton) {
            return;
        }

        // 合成中や開始処理中は、古いキャッシュをダウンロードさせないために無効化
        if (isConversionStarting || currentXhrs.length > 0) {
            dlButton.disabled = true;
            dlButton.style.backgroundColor = ''; // 無効にする場合（GM_addStyleのdisabledに任せる）
            return;
        }

        const currentText = responseAnswerText();

        if (!currentText) {
            dlButton.disabled = true;
            dlButton.style.backgroundColor = '';
            return;
        }

        // 現在の画面上の回答から「あるべきハッシュ」を生成
        const currentHash = generateCacheKey(currentText);
        // 保存されている「最後に成功したキャッシュのハッシュ」を取得
        const cachedHash = GM_getValue(LAST_CACHE_HASH, null);

        // ハッシュが完全に一致する場合のみ有効化（青色にする）
        const isMatch = (cachedHash !== null && currentHash === cachedHash);

        if (dlButton.disabled !== !isMatch) {
            dlButton.disabled = !isMatch;
        }
        dlButton.style.backgroundColor = isMatch ? '#007bff' : '';
    }

    // SVGを生成する関数
    function createSvgElement(viewBox, pathData, isSync) {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("viewBox", viewBox);
        svg.setAttribute("fill", "currentColor");
        svg.style.width = "1em";
        svg.style.height = "1em";

        // 合成中の時だけくるくる回るクラスをつけるわ
        if (isSync) {
            svg.style.animation = "spin 1.5s linear infinite";
        }

        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", pathData);
        svg.appendChild(path);

        return svg;
    }

    // 再生ボタンの状態を更新するわ！
    function updateButtonState() {
        const button = document.getElementById('convertButton');
        if (!button) {
            return;
        }
        const icon = document.getElementById('convertButtonIcon');
        const text = document.getElementById('convertButtonText');
        if (!icon || !text) {
            return;
        }

        // 現在の状態を保存しておき、不要な DOM 操作を避ける
        const currentText = text.textContent.trim();
        const currentBg = button.style.backgroundColor;

        button.removeEventListener('click', stopPlayback);
        button.removeEventListener('click', resumeContext);
        button.removeEventListener('click', stopConversion);
        button.removeEventListener('click', startConversion);

        const mode = config.iconMode || 'awesome';
        const def = ICON_DEFINITIONS[mode];

        // --- 状態ごとの設定 ---
        if (isPlaying) {
            if (currentText !== '停止') {
                if (def.type === 'text') {
                    icon.textContent = def.stop; // 絵文字なら安全にテキスト代入
                } else {
                    icon.textContent = '';
                    const svgNode = createSvgElement(def.viewBox, def.stop, false);
                    icon.appendChild(svgNode); // 安全にSVGタグを合体させる！
                }
                text.textContent = ' 停止';
                button.style.backgroundColor = '#dc3545';
            }
            button.addEventListener('click', stopPlayback);
            if (DEBUG_BUTTON) {
                console.log(`[Debug] [${getFormattedDateTime()}] 停止`);
            }
        } else if (isPause && audioContext) {
            if (currentText !== '待機中...') {
                if (def.type === 'text') {
                    icon.textContent = def.wait;
                } else {
                    icon.textContent = '';
                    const svgNode = createSvgElement(def.viewBox, def.wait, false);
                    icon.appendChild(svgNode);
                }
                text.textContent = ' 待機中...';
                button.style.backgroundColor = '#e67e22';
            }
            button.addEventListener('click', resumeContext);
            if (DEBUG_BUTTON) {
                console.log(`[Debug] [${getFormattedDateTime()}] 待機中`);
            }
        } else if (isConversionStarting || currentXhrs.length > 0) {
            if (currentText !== '合成中...') {
                if (def.type === 'text') {
                    icon.textContent = def.sync;
                } else {
                    icon.textContent = '';
                    const svgNode = createSvgElement(def.viewBox, def.sync, true);
                    icon.appendChild(svgNode);
                }
                text.textContent = ' 合成中...';
                button.style.backgroundColor = '#6c757d';
            }
            button.addEventListener('click', stopConversion);
            if (DEBUG_BUTTON) {
                console.log(`[Debug] [${getFormattedDateTime()}] 合成中`);
            }
        } else {
            if (currentText !== '再生') {
                if (def.type === 'text') {
                    icon.textContent = def.play;
                } else {
                    icon.textContent = '';
                    const svgNode = createSvgElement(def.viewBox, def.play, false);
                    icon.appendChild(svgNode);
                }
                text.textContent = ' 再生';
                button.style.backgroundColor = '#007bff';
            }
            button.addEventListener('click', startConversion);
            if (DEBUG_BUTTON) {
                console.log(`[Debug] [${getFormattedDateTime()}] 再生`);
            }
        }
        updateDownloadButtonState();
    }

    // ボタンを追加するDOM操作の初期化処理
    function addConvertButton() {
        const buttonId = 'convertButton';
        const dlButtonId = 'downloadButton';
        const wrapperId = 'convertButtonWrapper';
        let button = document.getElementById(buttonId);
        let wrapper = document.getElementById(wrapperId);
        let lastAnswerPanel = null;
        let footerSelector = null;

        for (const selector of config.selectorsResponse) {
            if (DEBUG_BUTTON) {
                console.log(`[DEBUG] 検索中: selector.container = "${selector.container}"`);
            }
            const containers = document.querySelectorAll(selector.container);
            if (containers.length > 0) {
                lastAnswerPanel = containers[containers.length - 1];
                footerSelector = selector.footer;
                if (DEBUG_BUTTON) {
                    console.log(`[DEBUG] lastAnswerPanel = "${lastAnswerPanel}"\nfooterSelector = "${footerSelector}"\n`);
                }
                break;
            }
        }
        if (!lastAnswerPanel || !footerSelector) {
            return;
        }

        let lastButton = null;
        const allButtons = lastAnswerPanel.querySelectorAll(footerSelector + ':not(#' + buttonId + '):not(#' + dlButtonId + ')');
        lastButton = allButtons[allButtons.length - 1];
        if (!lastButton) {
            return;
        }

        // 最適化ロジック（不要な場合に再配置と再作成をスキップ）
        if (button && wrapper && lastButton.nextElementSibling === wrapper) {
            // ラッパーが正しい位置にあるため、DOM操作をスキップして状態更新へ
            let iconSpan = document.getElementById('convertButtonIcon');
            let textSpan = document.getElementById('convertButtonText');

            if (!iconSpan || !textSpan) {
                // アイコン/テキストがない場合、再作成（このパスに入る可能性は低いが安全策）
                button.textContent = '';
                iconSpan = document.createElement('span');
                iconSpan.id = 'convertButtonIcon';
                textSpan = document.createElement('span');
                textSpan.id = 'convertButtonText';
                button.appendChild(iconSpan);
                button.appendChild(textSpan);
                resetOperation();
            } else {
                updateButtonState();
            }
            return;
        }

        if (lastButton) {
            if (wrapper && lastButton.nextElementSibling !== wrapper) {
                wrapper.remove();
                wrapper = null;
            }
            if (!wrapper) {
                // ラッパーを作成（Flex Itemとして機能させるため）
                wrapper = document.createElement('div');
                wrapper.id = wrapperId;

                // 再生ボタンの作成
                button = document.createElement('button');
                button.id = buttonId;
                // v3.5のカスタムCSSを適用
                button.style.cssText = 'padding: 2px 4px; background-color: #007bff; color: white; border: none; cursor: pointer; margin-left: 4px; border-radius: 16px; hover:scale-105';
                wrapper.appendChild(button);

                // ダウンロードボタンの作成
                if (config.dlBtnEnabled) {
                    const dlButton = document.createElement('button');
                    dlButton.id = dlButtonId;
                    dlButton.disabled = true;

                    // ダウンロードボタンのスタイル設定
                    dlButton.style.cssText = `
                        padding: 2px 4px;
                        background-color: #007bff;
                        color: white;
                        border: none;
                        cursor: pointer;
                        margin-left: 8px;
                        width: 28px; /* 丸くするために固定サイズ */
                        height: 28px;
                        border-radius: 50%; /* 丸くする */
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    `;

                    // アイコンを追加
                    const dlIconSpan = document.createElement('span');
                    const mode = config.iconMode || 'awesome';
                    const def = ICON_DEFINITIONS[mode];
                    if (def.type === 'text') {
                        dlIconSpan.textContent = def.save;
                    } else {
                        dlIconSpan.textContent = '';
                        const svgNode = createSvgElement(def.viewBox, def.save, false);
                        dlIconSpan.appendChild(svgNode);
                    }
                    dlIconSpan.id = 'downloadButtonIcon';
                    dlButton.appendChild(dlIconSpan);

                    // イベントリスナーを追加
                    dlButton.addEventListener('click', startVoiceDownload);
                    wrapper.appendChild(dlButton);
                }
            } else {
                button = document.getElementById(buttonId);
                if (!button) {
                    return;
                }
            }

            let iconSpan = document.getElementById('convertButtonIcon');
            let textSpan = document.getElementById('convertButtonText');

            if (!iconSpan || !textSpan) {
                button.textContent = '';

                iconSpan = document.createElement('span');
                iconSpan.id = 'convertButtonIcon';
                textSpan = document.createElement('span');
                textSpan.id = 'convertButtonText';

                button.appendChild(iconSpan);
                button.appendChild(textSpan);
            }

            lastButton.insertAdjacentElement('afterend', wrapper);

            if (!document.getElementById('convertButtonIcon').innerHTML) {
                resetOperation();
            } else {
                updateButtonState();
            }
        } else {
            console.log("ターゲット要素が見つかりませんでした。");
        }
    }

    /**
     * 現在のURLがスクリプトを実行すべきチャット画面かどうかをチェックする関数
     * @param {string} currentUrl - 現在の window.location.href
     * @returns {boolean} - スクリプトを実行すべきチャット画面なら true
     */
    function isChatPage(currentUrl) {
        const url = currentUrl.toLowerCase();
        const urlObj = new URL(url); // URLオブジェクト

        // searchが空文字列でなければ '?' を含みます (例: '/search?udm=50')
        const pathAndQuery = urlObj.pathname + urlObj.search;

        // --- ヘルパー関数: パスパターンを正規表現に変換 ---
        const pathToRegex = (path) => {
            // 正規表現の特殊文字のうち、'*'以外をエスケープする
            let escapedPath = path.replace(/[-\\^$+?.()|[\]{}]/g, '\\$&');
            // ワイルドカード '*' を、あらゆる文字の集合にマッチさせる正規表現に変換
            // 💡 変更点: ワイルドカード '*' が、もはや '/' 以外の文字に限定されない
            escapedPath = escapedPath.replace(/\*/g, '.*');
            // パターンで始まり、その後に何かあってもOK、というパターンで終了
            // ただし、pathAndQueryがURLの終端（#ハッシュなど）であれば、正規表現の終わり($)で終わる
            return new RegExp(`^${escapedPath}$`); // $をつけることで、パターン以降に文字がないことを確認する
        };

        // --- 1. ホワイトリストチェック (許可パターン) ---
        const isWhiteListed = config.whitelistPaths.some(path => {
            // ルート ('/') は完全一致で確認するわ
            if (path === '/') {
                return pathAndQuery === '/';
            }

            // 正規表現でマッチするかチェック
            return pathAndQuery.match(pathToRegex(path));
        });

        // ホワイトリストに全くマッチしないなら、問答無用で false よ
        if (!isWhiteListed) {
            return false;
        }

        // --- 2. ブラックリストチェック (除外パターン) ---
        const isBlackListed = config.blacklistPaths.some(path => {
            return pathAndQuery.match(pathToRegex(path));
        });

        // --- 3. 最終判断 ---
        return !isBlackListed;
    }

    // MutationObserverのロジック
    function observeDOMChanges() {
        // 監視ノードをdocument.bodyに固定
        const TARGET_NODE = document.body;
        let allResponseContainers = null;
        let footerSelector = '';
        const observer = new MutationObserver(function(mutations, observer) {
            // URLチェック: チャットページでない場合は、debouncerを起動せず即座に終了するわ
            if (!isChatPage(window.location.href)) {
                return; // DOM変更を無視して、何もしないで return するわ
            }

            // DOM操作が落ち着くまで待つ（デバウンス）
            clearTimeout(debounceTimerId);
            debounceTimerId = setTimeout(function() {
                addConvertButton();
                updateButtonState();
                refreshMenuCommands();

                if (audioContext && isPause && audioContext.currentTime > 0) {
                    isPause = false;
                    isPlaying = true;
                    showToast('🔊 再生開始！素敵な声が聞こえてくるわ！', true);
                }

                // 自動再生ロジック
                const button = document.getElementById('convertButton');

                // 自動再生がONで、ボタンが存在し、再生/合成中でなく、まだ自動再生されていない場合
                if (config.autoPlay && button) {
                    // 正確な最新回答パネルの特定
                    for (const selector of config.selectorsResponse) {
                        const containers = document.querySelectorAll(selector.container);
                        if (containers.length > 0) {
                            allResponseContainers = containers;
                            footerSelector = selector.footer;
                            break;
                        }
                    }
                    if (!allResponseContainers || allResponseContainers.length === 0) {
                        return;
                    }
                    const answerContainer = allResponseContainers[allResponseContainers.length - 1]; // 最後の回答パネルを取得
                    const footerEl = (answerContainer && footerSelector) ? answerContainer.querySelector(footerSelector) : null;
                    const hasFooter = (footerEl && footerEl.offsetParent !== null) ? footerEl : null;
                    const minLength = config.minTextLength || 0;
                    const currentText = responseAnswerText();

                    // フッターがあり＆最小文字数を超えている＆キャッシュと比較して別のものの場合に自動再生
                    if (currentText && currentText !== lastAutoPlayedText && currentText.length > 0) {
                        if (currentText.length <= minLength) {
                            console.log(`読み上げテキストが最小文字数(${minLength}文字)以下です（${currentText.length}文字）: ${currentText.substring(0, 40)}...`);
                        } else if (hasFooter) {
                            lastAutoPlayedText = currentText;
                            startConversion(true); // trueで自動再生として実行
                        }
                    }
                }
            }, config.debounceDelay);
        });

        const observerConfig = {
            childList: true,
            subtree: true,
            attributes: true,
        };
        observer.observe(TARGET_NODE, observerConfig);

        // 初回レンダリング現象対策
        if (isChatPage(window.location.href)) {
            let initialRetryCount = 0;
            const initialRetryLimit = 20; // 20回（約10秒）で諦める

            const initialRetryInterval = setInterval(() => {
                initialRetryCount++;
                // console.log(`[Fix] 初回発動リトライ #${initialRetryCount}`);

                // ここでも念のためチェック（URLが変わる可能性もある）
                if (!isChatPage(window.location.href)) {
                    // console.log("[Fix] URLがチャットページじゃなくなったのでリトライ中止");
                    clearInterval(initialRetryInterval);
                    return;
                }

                addConvertButton();

                // 成功判定
                if (document.getElementById('convertButton')) {
                    // console.log("[Fix] 初回ボタン成功！これで安心だね！");
                    clearInterval(initialRetryInterval);
                } else if (initialRetryCount >= initialRetryLimit) {
                    // console.log("[Fix] 初回リトライ上限…でも次からはdebounceで大丈夫！");
                    clearInterval(initialRetryInterval); // initialRetryLimit で諦める (20回で約10秒)
                }
            }, 500);

            // クリック保険もガード付き
            const clickHandler = () => {
                if (isChatPage(window.location.href)) {
                    // console.log("[Fix] クリックで強制発動！");
                    addConvertButton();
                }
                document.removeEventListener('click', clickHandler);
            };
            document.addEventListener('click', clickHandler, {
                once: true,
                capture: true,
            });
        }
    }

    // メニュー登録
    function refreshMenuCommands() {
        if (menuIds.settings) {
            GM_unregisterMenuCommand(menuIds.settings);
        }
        menuIds.settings = GM_registerMenuCommand('🔊 VOICEVOX連携 設定', openSettings);
        if (menuIds.rvc) {
            GM_unregisterMenuCommand(menuIds.rvc);
        }
        menuIds.rvc = GM_registerMenuCommand('🔊 RVC連携 設定', openRvcSettings);
        if (menuIds.download) {
            GM_unregisterMenuCommand(menuIds.download);
        }
        menuIds.download = GM_registerMenuCommand('💾 ダウンロード', startVoiceDownload);
        if (menuIds.cache) {
            GM_unregisterMenuCommand(menuIds.cache);
        }
        menuIds.cache = GM_registerMenuCommand('🗑️ キャッシュクリア', clearCached);
    }

    refreshMenuCommands();

    // DOM監視を開始
    observeDOMChanges();

    // グローバルキーイベントリスナー
    document.addEventListener('keydown', handleGlobalKeyDown);

    // 画面のどこをクリックしても、待機中なら再開させる
    document.addEventListener('click', () => {
        // isPause が true で、かつ AudioContext がサスペンド状態なら再開！
        if (isPause && audioContext && audioContext.state === 'suspended') {
            if (DEBUG) {
                console.log('[Autoplay] 画面クリックを検知。再生を再開するわ！');
            }
            resumeContext();
        }
    }, { capture: true, }); // 他の要素のクリックイベントより先に捕まえるために capture を使うのがおすすめ

})();