"""回归 QQ 邮箱在邮件正文后返回 INTERNALDATE 的真实响应结构。"""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src.common import MVPError
from src.config import AppConfig, DEFAULT_CONFIG
from src.data_store import SqliteDataStore
from src.email_fetcher import email_received_time, fetch_emails, fetch_metadata
from tests.helpers import FakeIMAP, message_bytes
from tests.test_phash import jpeg_bytes


class DateResponseIMAP(FakeIMAP):
    def __init__(self, messages, layout="after", missing_uid=None):
        super().__init__(messages)
        self.layout = layout
        self.missing_uid = missing_uid

    def uid(self, operation, *args):
        status, data = super().uid(operation, *args)
        if operation != "FETCH" or args[1] != "(BODY.PEEK[] INTERNALDATE)":
            return status, data
        uid = int(args[0])
        raw = self.messages[uid]
        prefix = f'51 (UID {uid} BODY[] {{{len(raw)}}}'.encode()
        date = b' INTERNALDATE "5-Nov-2026 20:31:44 +0800"'
        if uid == self.missing_uid:
            return status, [(prefix, raw), b")"]
        if self.layout == "before":
            return status, [(prefix + date, raw), b")"]
        if self.layout == "mixed_case":
            date = b' internaldate\t " 5-nOv-2026 20:31:44 +0800"'
        if self.layout == "malformed":
            date = b' INTERNALDATE "not-a-date"'
        if self.layout == "separate":
            return status, [None, b"51 (FLAGS (\\Seen))", (prefix, raw), date, b")"]
        return status, [(prefix, raw), date + b")"]


class ImapDateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.config = AppConfig(**{**DEFAULT_CONFIG, "email_account": "teacher@qq.com", "imap_auth_code": "TEST-SECRET"})

    def fetch(self, server, store):
        with patch("src.email_fetcher.imaplib.IMAP4_SSL", return_value=server):
            return fetch_emails(self.config, store, self.folder)

    def test_before_after_and_separate_metadata_use_same_server_time(self):
        for layout in ("before", "after", "separate", "mixed_case"):
            with self.subTest(layout=layout):
                store = SqliteDataStore(self.folder / f"{layout}.db")
                server = DateResponseIMAP({718: message_bytes(photos=[("photo.jpg", jpeg_bytes())])}, layout)
                self.assertEqual(self.fetch(server, store), {"emails": 1, "records": 1})
                row = store.load_records()[0]
                self.assertEqual(row["email_time"], "2026-11-05T20:31:44+08:00")
                self.assertEqual(store.load_checkpoint()["last_uid"], 718)
                self.assertTrue(server.logged_out)
                # 幂等重试不会重新保存附件。
                self.assertEqual(self.fetch(server, store)["records"], 0)
                self.assertEqual(len(store.load_records()), 1)

    def test_metadata_never_includes_literal_body_or_fake_internaldate(self):
        raw = b'Subject: test\r\nDate: Mon, 01 Jan 2001 00:00:00 +0000\r\n\r\nINTERNALDATE "1-Jan-2001 00:00:00 +0000"'
        metadata = fetch_metadata([(b"51 (UID 718 BODY[] {128}", raw), b")", None])
        self.assertNotIn(b"2001", metadata)
        with self.assertRaisesRegex(MVPError, "没有提供 INTERNALDATE"):
            email_received_time(metadata)

    def test_missing_or_invalid_date_keeps_previous_records_and_progress(self):
        messages = {717: message_bytes(photos=[("a.jpg", jpeg_bytes())]),
                    718: message_bytes(photos=[("b.jpg", jpeg_bytes())])}
        store = SqliteDataStore(self.folder / "resume.db")
        server = DateResponseIMAP(messages, missing_uid=718)
        with self.assertRaisesRegex(MVPError, "没有提供 INTERNALDATE"):
            self.fetch(server, store)
        self.assertEqual(store.load_checkpoint()["last_uid"], 717)
        self.assertEqual(len(store.load_records()), 1)
        self.assertTrue(server.logged_out)
        malformed = DateResponseIMAP(messages, "malformed")
        with self.assertRaisesRegex(MVPError, "收件时间无法解析"):
            self.fetch(malformed, store)
        self.assertEqual(store.load_checkpoint()["last_uid"], 717)
        self.assertEqual(len(store.load_records()), 1)
        self.assertEqual(self.fetch(DateResponseIMAP(messages), store), {"emails": 1, "records": 1})
        self.assertEqual(store.load_checkpoint()["last_uid"], 718)
        self.assertEqual(len(store.load_records()), 2)


if __name__ == "__main__":
    unittest.main()
