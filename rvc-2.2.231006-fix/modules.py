import traceback
import logging

logger = logging.getLogger(__name__)

import numpy as np
import soundfile as sf
import torch
from io import BytesIO

import json    # JSONを扱うために必要
import base64  # Base64エンコードのために必要
import io      # WAVファイルをメモリ上で扱うために必要

from infer.lib.audio import load_audio, wav2
from infer.lib.infer_pack.models import (
    SynthesizerTrnMs256NSFsid,
    SynthesizerTrnMs256NSFsid_nono,
    SynthesizerTrnMs768NSFsid,
    SynthesizerTrnMs768NSFsid_nono,
)
from infer.modules.vc.pipeline import Pipeline
from infer.modules.vc.utils import *


class VC:
    def __init__(self, config):
        self.n_spk = None
        self.tgt_sr = None
        self.net_g = None
        self.pipeline = None
        self.cpt = None
        self.version = None
        self.if_f0 = None
        self.version = None
        self.hubert_model = None

        self.config = config

    def get_vc(self, sid, *to_return_protect):
        logger.info("Get sid: " + sid)

        to_return_protect0 = {
            "visible": self.if_f0 != 0,
            "value": to_return_protect[0]
            if self.if_f0 != 0 and to_return_protect
            else 0.5,
            "__type__": "update",
        }
        to_return_protect1 = {
            "visible": self.if_f0 != 0,
            "value": to_return_protect[1]
            if self.if_f0 != 0 and to_return_protect
            else 0.33,
            "__type__": "update",
        }

        if sid == "" or sid == []:
            if self.hubert_model is not None:  # 考虑到轮询, 需要加个判断看是否 sid 是由有模型切换到无模型的
                logger.info("Clean model cache")
                del (self.net_g, self.n_spk, self.hubert_model, self.tgt_sr)  # ,cpt
                self.hubert_model = (
                    self.net_g
                ) = self.n_spk = self.hubert_model = self.tgt_sr = None
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                ###楼下不这么折腾清理不干净
                self.if_f0 = self.cpt.get("f0", 1)
                self.version = self.cpt.get("version", "v1")
                if self.version == "v1":
                    if self.if_f0 == 1:
                        self.net_g = SynthesizerTrnMs256NSFsid(
                            *self.cpt["config"], is_half=self.config.is_half
                        )
                    else:
                        self.net_g = SynthesizerTrnMs256NSFsid_nono(*self.cpt["config"])
                elif self.version == "v2":
                    if self.if_f0 == 1:
                        self.net_g = SynthesizerTrnMs768NSFsid(
                            *self.cpt["config"], is_half=self.config.is_half
                        )
                    else:
                        self.net_g = SynthesizerTrnMs768NSFsid_nono(*self.cpt["config"])
                del self.net_g, self.cpt
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            return (
                {"visible": False, "__type__": "update"},
                {
                    "visible": True,
                    "value": to_return_protect0,
                    "__type__": "update",
                },
                {
                    "visible": True,
                    "value": to_return_protect1,
                    "__type__": "update",
                },
                "",
                "",
            )
        person = f'{os.getenv("weight_root")}/{sid}'
        logger.info(f"Loading: {person}")

        self.cpt = torch.load(person, map_location="cpu")
        self.tgt_sr = self.cpt["config"][-1]
        self.cpt["config"][-3] = self.cpt["weight"]["emb_g.weight"].shape[0]  # n_spk
        self.if_f0 = self.cpt.get("f0", 1)
        self.version = self.cpt.get("version", "v1")

        synthesizer_class = {
            ("v1", 1): SynthesizerTrnMs256NSFsid,
            ("v1", 0): SynthesizerTrnMs256NSFsid_nono,
            ("v2", 1): SynthesizerTrnMs768NSFsid,
            ("v2", 0): SynthesizerTrnMs768NSFsid_nono,
        }

        self.net_g = synthesizer_class.get(
            (self.version, self.if_f0), SynthesizerTrnMs256NSFsid
        )(*self.cpt["config"], is_half=self.config.is_half)

        del self.net_g.enc_q

        self.net_g.load_state_dict(self.cpt["weight"], strict=False)
        self.net_g.eval().to(self.config.device)
        if self.config.is_half:
            self.net_g = self.net_g.half()
        else:
            self.net_g = self.net_g.float()

        self.pipeline = Pipeline(self.tgt_sr, self.config)
        n_spk = self.cpt["config"][-3]
        index = {"value": get_index_path_from_model(sid), "__type__": "update"}
        logger.info("Select index: " + index["value"])

        self.loaded_model_id = sid              # ロードされたモデルのファイル名（sid）を保持

        return (
            (
                {"visible": True, "maximum": n_spk, "__type__": "update"},
                to_return_protect0,
                to_return_protect1,
                index,
                index,
            )
            if to_return_protect
            else {"visible": True, "maximum": n_spk, "__type__": "update"}
        )

    def vc_single(
        self,
        sid,
        input_audio_path,
        f0_up_key,
        f0_file,
        f0_method,
        file_index,
        file_index2,
        index_rate,
        filter_radius,
        resample_sr,
        rms_mix_rate,
        protect,
    ):

        # ★★★ ファイルオブジェクトからのパス強制抽出！ ★★★
        # Index 1が空の場合に、Index 3からパスを抽出し、input_audio_pathに上書きする！
        if (input_audio_path is None or input_audio_path == ""):
            # 1. f0_fileが文字列（パス）の場合 (V4.0/V7.0の横取りロジック)
            if isinstance(f0_file, str) and f0_file != "":
                input_audio_path = f0_file
                f0_file = None
            # 2. f0_fileがファイルオブジェクトの場合 (NEW! ファイルオブジェクトから.name属性でパスを抽出)
            elif hasattr(f0_file, 'name') and isinstance(getattr(f0_file, 'name'), str) and getattr(f0_file, 'name') != "":
                input_audio_path = getattr(f0_file, 'name') # パスをゲット！
                f0_file = None

        if input_audio_path is None:
            return "You need to upload an audio", None
        f0_up_key = int(f0_up_key)
        try:
            audio = load_audio(input_audio_path, 16000)
            audio_max = np.abs(audio).max() / 0.95
            if audio_max > 1:
                audio /= audio_max
            times = [0, 0, 0]

            if self.hubert_model is None:
                self.hubert_model = load_hubert(self.config)

            file_index = (
                (
                    file_index.strip(" ")
                    .strip('"')
                    .strip("\n")
                    .strip('"')
                    .strip(" ")
                    .replace("trained", "added")
                )
                if file_index != ""
                else file_index2
            )  # 防止小白写错，自动帮他替换掉

            audio_opt = self.pipeline.pipeline(
                self.hubert_model,
                self.net_g,
                sid,
                audio,
                input_audio_path,
                times,
                f0_up_key,
                f0_method,
                file_index,
                index_rate,
                self.if_f0,
                filter_radius,
                self.tgt_sr,
                resample_sr,
                rms_mix_rate,
                self.version,
                protect,
                f0_file,
            )
            if self.tgt_sr != resample_sr >= 16000:
                tgt_sr = resample_sr
            else:
                tgt_sr = self.tgt_sr
            index_info = (
                "Index:\n%s." % file_index
                if os.path.exists(file_index)
                else "Index not used."
            )

            # (tgt_sr, audio_opt) は Gradio の Audio コンポーネントが処理するために必要なので維持
            audio_return = (tgt_sr, audio_opt)

            # ★★★ Base64 エンコード処理を開始！ ★★★

            # クールにパスをクリーニングして、soundfile.LibsndfileError: Error opening '"...' を解決するわ！
            # input_audio_path が文字列であり、Noneではないことを確認
            cleaned_input_path = ""
            if input_audio_path and isinstance(input_audio_path, str):
                # 両端のスペース、クォート、改行をすべて削除して安全なパスにするわ！
                cleaned_input_path = input_audio_path.strip(" ").strip('"').strip("\n")

            # cleaned_input_path が一時ファイルパスであることを利用して、そのディレクトリに一時ファイルを作成
            # パスがない場合はカレントディレクトリ './' を使うわ
            temp_dir = os.path.dirname(cleaned_input_path) if cleaned_input_path and os.path.dirname(cleaned_input_path) else "./"

            # ファイル名にプロセスIDを入れて衝突を防ぐわ
            temp_wav_path = os.path.join(temp_dir, f"temp_rvc_base64_{os.getpid()}.wav")

            # sf.write (soundfile.write) を使用してWAVを書き出し！（NameErrorとLibsndfileErrorを同時解決よ！）
            sf.write(temp_wav_path, audio_opt, tgt_sr, format='WAV')

            # WAVファイルを読み込み、Base64にエンコード
            with open(temp_wav_path, "rb") as f:
                raw_base64 = base64.b64encode(f.read()).decode('utf-8')

            os.remove(temp_wav_path) # 一時ファイルを削除！

            base64_data_uri = f"data:audio/wav;base64,{raw_base64}"
            # ----------------------------------------------------

            audio_return = (tgt_sr, audio_opt) # WebUIのAudioコンポーネント向け

            return (
                # 1番目の戻り値 (WebUIのテキストボックス向け) - 元の形式に戻すわ！
                "Success.\n%s\nTime:\nnpy: %.2fs, f0: %.2fs, infer: %.2fs."
                % (index_info, *times),

                # 2番目の戻り値 (WebUIのAudioコンポーネント向け)
                audio_return,

                # ★V6.2-38-3: 3番目の戻り値 (UserScript向け Base64データ！)
                {
                    "name": "rvc_conversion.wav",
                    "data": base64_data_uri,
                    "is_us_base64": True # UserScript識別子
                }
            )
        except:
            info = traceback.format_exc()
            logger.warning(info)
            # Base64化でエラーが出た場合も、WebUIのために元のエラー形式に戻すわ
            return info, (None, None), None

    def vc_multi(
        self,
        sid,
        dir_path,
        opt_root,
        paths,
        f0_up_key,
        f0_method,
        file_index,
        file_index2,
        index_rate,
        filter_radius,
        resample_sr,
        rms_mix_rate,
        protect,
        format1,
    ):
        try:
            dir_path = (
                dir_path.strip(" ").strip('"').strip("\n").strip('"').strip(" ")
            )  # 防止小白拷路径头尾带了空格和"和回车
            opt_root = opt_root.strip(" ").strip('"').strip("\n").strip('"').strip(" ")
            os.makedirs(opt_root, exist_ok=True)
            try:
                if dir_path != "":
                    paths = [
                        os.path.join(dir_path, name) for name in os.listdir(dir_path)
                    ]
                else:
                    paths = [path.name for path in paths]
            except:
                traceback.print_exc()
                paths = [path.name for path in paths]
            infos = []
            for path in paths:
                info, opt, base64_opt = self.vc_single(
                    sid,
                    path,
                    f0_up_key,
                    None,
                    f0_method,
                    file_index,
                    file_index2,
                    # file_big_npy,
                    index_rate,
                    filter_radius,
                    resample_sr,
                    rms_mix_rate,
                    protect,
                )
                if "Success" in info:
                    # ここで base64_opt を利用する処理を追加できます。
                    # 例: logger.info(f"Base64 data for {path} is available: {base64_opt['name']}")
                    try:
                        tgt_sr, audio_opt = opt
                        if format1 in ["wav", "flac"]:
                            sf.write(
                                "%s/%s.%s"
                                % (opt_root, os.path.basename(path), format1),
                                audio_opt,
                                tgt_sr,
                            )
                        else:
                            path = "%s/%s.%s" % (
                                opt_root,
                                os.path.basename(path),
                                format1,
                            )
                            with BytesIO() as wavf:
                                sf.write(wavf, audio_opt, tgt_sr, format="wav")
                                wavf.seek(0, 0)
                                with open(path, "wb") as outf:
                                    wav2(wavf, outf, format1)
                    except:
                        info += traceback.format_exc()
                infos.append("%s->%s" % (os.path.basename(path), info))
                yield "\n".join(infos)
            yield "\n".join(infos)
        except:
            yield traceback.format_exc()
