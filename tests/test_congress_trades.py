#!/usr/bin/env python3
"""Unit tests for congress_trades.parse_ptr_text — the House Clerk PTR parser.

Pins the filing that went missing: Nancy Pelosi's 2026-08-21 PTR (DocID
20035143) renders the transaction + notification dates SPACE-separated and the
parser only accepted them concatenated, so six real purchases (BE shares and
calls, INTC calls and shares) parsed to zero rows and the mirror was blind
while the daily cron reported success. Pure: no DB, no network.
Run: pytest tests/test_congress_trades.py
"""

from __future__ import annotations

import unittest

import congress_trades as ct


# The text pypdf extracts from DocID 20035143 (2 pages), verbatim shape:
# space-separated dates, the amount band wrapping onto the next line, one
# non-ticker LLC row, and the signature footer.
PTR_20035143 = """\
P T R
Clerk of the House of Representatives • Legislative Resource Center • B81 Cannon Building • Washington, DC 20515
F I
Name: Hon. Nancy Pelosi
Status: Member
State/District: CA11
T
ID Owner Asset Transaction
Type
Date Notification
Date
Amount Cap.
Gains >
$200?
SP Bloom Energy Corporation Class A
Common Stock (BE) [ST]
P 07/24/2026 07/24/2026 $1,000,001 -
$5,000,000
F S: New
D: Purchased 10,000 shares.
SP Bloom Energy Corporation Class A
Common Stock (BE) [OP]
P 07/24/2026 07/24/2026 $1,000,001 -
$5,000,000
F S: New
D: Purchased 100 call options with a strike price of $100 and an expiration date of 6/17/27.
SP Bloom Energy Corporation Class A
Common Stock (BE) [ST]
P 07/28/2026 07/28/2026 $500,001 -
$1,000,000
F S: New
D: Purchased 5,000 shares.
SP Bloom Energy Corporation Class A
Common Stock (BE) [OP]
P 07/28/2026 07/28/2026 $500,001 -
$1,000,000
F S: New
D: Purchased 100 call options with a strike price of $100 and an expiration date of 6/17/27.
SP Intel Corporation - Common Stock
(INTC) [OP]
P 07/24/2026 07/24/2026 $250,001 -
$500,000
F S: New
D: Purchased 50 call options with a strike price of $50 and an expiration date of 6/17/27.
SP Intel Corporation - Common Stock
(INTC) [ST]
P 07/24/2026 07/24/2026 $500,001 -
$1,000,000
F S: New
D: Purchased 10,000 shares.
Filing ID #20035143
ID Owner Asset Transaction
Type
Date Notification
Date
Amount Cap.
Gains >
$200?
SP REOF XXV, LLC [AB] P 07/27/2026 07/27/2026 $500,001 -
$1,000,000
F S: New
D: Additional investment in LLC which is acquiring and restoring a luxury hotel property in San Francisco, CA.
* For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx.
I P O
 Yes  No
C  S
 I CERTIFY that the statements I have made on the attached Periodic Transaction Report are true, complete, and correct to the best of
my knowledge and belief. Further, I CERTIFY that I have disclosed all transactions as required by the STOCK Act.
Digitally Signed: Hon. Nancy Pelosi , 08/21/2026
"""

# The earlier layout the parser was written against: dates concatenated, NUL
# padding in the field labels.
PTR_CONCATENATED = (
    "SP NVIDIA Corporation - Common Stock (NVDA) [ST] S (partial) "
    "06/20/202606/23/2026 $1,000,001 -\n$5,000,000\n"
    "F\x00\x00S\x00: New\nD\x00: Sold 10,000 shares.\n"
    "SP Alphabet Inc. - Class A (GOOGL) [OP] P 06/18/202606/23/2026 $250,001 - $500,000\n"
    "F S: New\nD: Purchased 50 call options.\n"
)


class Ptr20035143Tests(unittest.TestCase):
    def setUp(self):
        self.txns = ct.parse_ptr_text(PTR_20035143)

    def test_six_equity_rows_parsed(self):
        """The regression: this filing parsed to ZERO rows."""
        self.assertEqual(len(self.txns), 6)

    def test_rows(self):
        got = [(t.owner, t.ticker, t.asset_type, t.raw_txn_code, t.txn_type,
                t.txn_date, t.notification_date, t.amount_min, t.amount_max,
                t.is_option, t.is_gift) for t in self.txns]
        self.assertEqual(got, [
            ("SP", "BE", "ST", "P", "buy", "2026-07-24", "2026-07-24", 1_000_001, 5_000_000, False, False),
            ("SP", "BE", "OP", "P", "buy", "2026-07-24", "2026-07-24", 1_000_001, 5_000_000, True, False),
            ("SP", "BE", "ST", "P", "buy", "2026-07-28", "2026-07-28", 500_001, 1_000_000, False, False),
            ("SP", "BE", "OP", "P", "buy", "2026-07-28", "2026-07-28", 500_001, 1_000_000, True, False),
            ("SP", "INTC", "OP", "P", "buy", "2026-07-24", "2026-07-24", 250_001, 500_000, True, False),
            ("SP", "INTC", "ST", "P", "buy", "2026-07-24", "2026-07-24", 500_001, 1_000_000, False, False),
        ])

    def test_descriptions_come_from_the_right_row(self):
        descs = [t.description for t in self.txns]
        self.assertEqual(descs[0], "Purchased 10,000 shares.")
        self.assertIn("100 call options with a strike price of $100", descs[1])
        self.assertEqual(descs[2], "Purchased 5,000 shares.")
        self.assertIn("50 call options with a strike price of $50", descs[4])
        self.assertEqual(descs[5], "Purchased 10,000 shares.")

    def test_llc_row_without_a_ticker_is_not_a_trade(self):
        self.assertNotIn("LLC", [t.ticker for t in self.txns])
        self.assertFalse(any("hotel" in t.description for t in self.txns))

    def test_dedupe_hashes_distinct_per_row(self):
        hashes = {ct._dedupe_hash("Nancy Pelosi", "20035143", t) for t in self.txns}
        self.assertEqual(len(hashes), 6)


class ConcatenatedLayoutTests(unittest.TestCase):
    """The original layout must keep parsing — both forms are live."""

    def test_concatenated_dates_and_nul_padding(self):
        txns = ct.parse_ptr_text(PTR_CONCATENATED)
        self.assertEqual([(t.ticker, t.raw_txn_code, t.txn_type, t.txn_date,
                           t.notification_date, t.is_option) for t in txns], [
            ("NVDA", "S (partial)", "sell", "2026-06-20", "2026-06-23", False),
            ("GOOGL", "P", "buy", "2026-06-18", "2026-06-23", True),
        ])
        self.assertEqual(txns[0].description, "Sold 10,000 shares.")
        self.assertEqual(txns[0].amount_max, 5_000_000)


if __name__ == "__main__":
    unittest.main()
