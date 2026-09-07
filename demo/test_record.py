import os
import unittest
from unittest.mock import patch

from record import redacted


class RedactionTests(unittest.TestCase):
    def test_private_values_are_masked_without_moving_terminal_columns(self):
        values = [
            "01234567-89ab-cdef-0123-456789abcdef",
            "conv_exampleConversation000000000",
            "peer_exampleCredential00000000",
            "sk-exampleCredential00000000",
            "/Users/example",
        ]
        for value in values:
            with self.subTest(value=value):
                result = redacted(value)
                self.assertEqual(len(result), len(value))
                self.assertNotIn(value, result)
                self.assertIn("redacted", result)

    def test_public_aliases_receipts_and_ansi_free_text_survive(self):
        text = "codex-reviewer@m5dev dlv_publicReceipt DELIVERED"
        self.assertEqual(redacted(text), text)

    def test_local_username_is_masked(self):
        with patch.dict(os.environ, {"USER": "example-operator"}):
            self.assertEqual(redacted("example-operator"), "[user]".ljust(16))


if __name__ == "__main__":
    unittest.main()
