"""64 位 pHash 相似照片判定；只输出疑似重复，保留基础 EXIF 校验结果。"""

import logging
import re

log = logging.getLogger(__name__)
DUPLICATE_STATUSES = ("未校验", "未发现重复", "疑似重复", "校验异常")


def validate_threshold(value):
    if type(value) is not int or not 0 <= value <= 64:
        raise ValueError("pHash 汉明距离阈值必须为 0 到 64 的整数")
    return value


def hamming_distance(first, second):
    """异或后统计不同的位数；64 位 pHash 的汉明距离范围为 0～64。"""
    for value in (first, second):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{16}", value):
            raise ValueError("pHash 必须是 16 位十六进制字符串")
    return (int(first, 16) ^ int(second, 16)).bit_count()


def compare_photo(row, candidates):
    """候选仅包含更早入库记录（按 id）；并列时关联最早的一条。

    不按学号、窗口或基础有效性过滤，兼顾本人重复提交和跨学号复用。
    当前哈希及历史哈希异常仅影响本条比对，不中断后续记录。
    """
    result = dict(duplicate_status="未校验", duplicate_reason="照片尚无可用 pHash",
                  duplicate_record_id=None, duplicate_distance=None,
                  duplicate_threshold=row["duplicate_threshold"])
    try:
        threshold = validate_threshold(row["duplicate_threshold"])
        if row["phash_status"] == "校验异常":
            result.update(duplicate_status="校验异常", duplicate_reason=row.get("phash_reason") or "照片 pHash 计算失败")
            return result
        if row["phash_status"] != "已计算":
            return result
        # 即使没有历史记录，也检查当前哈希，避免错误地显示“未发现重复”。
        hamming_distance(row["photo_phash"], row["photo_phash"])
        best = None
        damaged = 0
        for candidate in candidates:
            if candidate["source_key"] == row["source_key"]:
                continue  # 幂等重试绝不把自己判为重复。
            try:
                distance = hamming_distance(row["photo_phash"], candidate["photo_phash"])
            except ValueError:
                log.exception("历史记录 #%s 的 pHash 损坏，跳过该候选。", candidate["id"])
                damaged += 1
                continue
            key = (distance, candidate["id"])
            if best is None or key < best:
                best = key
        if best is not None and best[0] <= threshold:
            distance, record_id = best
            result.update(duplicate_status="疑似重复", duplicate_record_id=record_id,
                          duplicate_distance=distance,
                          duplicate_reason=f"与历史记录 #{record_id} 相似：汉明距离 {distance} ≤ 阈值 {threshold}，待人工核验")
            if damaged:
                result["duplicate_reason"] += f"；另有 {damaged} 条历史哈希损坏未参与比对"
        elif damaged:
            result.update(duplicate_status="校验异常", duplicate_reason=f"{damaged} 条历史哈希损坏，比对不完整，请人工核验")
        else:
            result.update(duplicate_status="未发现重复", duplicate_reason="未发现阈值范围内的历史照片")
        return result
    except Exception:
        log.exception("照片相似度比对异常，当前记录转人工核验，继续处理后续照片。")
        result.update(duplicate_status="校验异常", duplicate_reason="照片相似度比对失败，请人工核验",
                      duplicate_record_id=None, duplicate_distance=None)
        return result
