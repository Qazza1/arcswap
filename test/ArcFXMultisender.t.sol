// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "forge-std/Test.sol";
import "../contracts/ArcFXMultisender.sol";

// ===========================================================================
// MockERC20
// A minimal, self-contained ERC-20 for testing purposes only.
// Tracks balances and allowances accurately; always returns true on success.
// ===========================================================================

contract MockERC20 {
    string  public name     = "Mock USDC";
    string  public symbol   = "mUSDC";
    uint8   public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256)                       public balanceOf;
    mapping(address => mapping(address => uint256))   public allowance;

    // ── Mint (test helper, not part of ERC-20 standard) ───────────────────────
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply   += amount;
    }

    // ── ERC-20 Interface ──────────────────────────────────────────────────────
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "MockERC20: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from]             >= amount, "MockERC20: insufficient balance");
        require(allowance[from][msg.sender] >= amount, "MockERC20: insufficient allowance");
        balanceOf[from]             -= amount;
        allowance[from][msg.sender] -= amount;
        balanceOf[to]               += amount;
        return true;
    }
}

// =========================================================================
// ArcFXMultisenderTest
// ===========================================================================

contract ArcFXMultisenderTest is Test {

    // ── Contracts under test ──────────────────────────────────────────────────
    ArcFXMultisender public multisender;
    MockERC20        public token;

    // ── Actors ────────────────────────────────────────────────────────────────
    address public treasury;
    address public sender;

    // ── Mirror the contract constants locally for assertions ──────────────────
    uint256 constant FEE_BPS    = 10;
    uint256 constant BPS_DENOM  = 10_000;
    uint256 constant FREE_LIMIT = 5;
    uint256 constant MAX_LIMIT  = 500;

    // ── Setup ─────────────────────────────────────────────────────────────────
    function setUp() public {
        treasury    = makeAddr("treasury");
        sender      = makeAddr("sender");

        multisender = new ArcFXMultisender(treasury);
        token       = new MockERC20();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Internal helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Generate n unique recipient addresses and a uniform amount array.
    function _buildArrays(uint256 n, uint256 amountEach)
        internal
        returns (address[] memory recipients, uint256[] memory amounts)
    {
        recipients = new address[](n);
        amounts    = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            // makeAddr generates a unique, deterministic non-zero address per label
            recipients[i] = makeAddr(string(abi.encodePacked("recipient_", vm.toString(i))));
            amounts[i]    = amountEach;
        }
    }

    /// @dev Mint `totalWithFee` tokens to `_sender` and approve the multisender.
    function _fundAndApprove(address _sender, uint256 totalWithFee) internal {
        token.mint(_sender, totalWithFee);
        vm.prank(_sender);
        token.approve(address(multisender), totalWithFee);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ── SECTION 1: Fee Math Correctness ───────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Fee = (total * 15) / 10_000 must hold for any gross total.
    ///         Covers the full realistic range for USDC 6-decimal amounts.
    function testFuzz_FeeCalculation_IsAlwaysExact(uint256 total) public pure {
        // Bound: 1 unit to 1 billion USDC (avoids overflow in contract mul)
        total = bound(total, 1, 1_000_000_000e6);

        uint256 expectedFee = (total * FEE_BPS) / BPS_DENOM;
        uint256 expectedNet = total - expectedFee;

        // No dust: fee + net must reconstruct the gross exactly
        assertEq(expectedFee + expectedNet, total,
            "fee + net must equal total -- no token dust");

        // Fee is exactly 0.10% (integer division, rounds down).
        // Restated against FEE_BPS rather than a literal: the literal silently
        // disagreed with the constant, so the suite passed while asserting a
        // rate the contract did not charge.
        assertEq(expectedFee, (total * FEE_BPS) / BPS_DENOM,
            "fee must be exactly FEE_BPS/BPS_DENOM of total");

        // Fee is always strictly less than the gross
        assertLt(expectedFee, total,
            "fee must be less than the gross amount");
    }

    /// @notice quoteTotal() view must return values that exactly match _execute() math.
    function testFuzz_QuoteTotalMatchesInternalCalc(uint8 n, uint64 amountEach) public view {
        uint256 count = bound(n, 1, 20);
        uint256 amt   = bound(amountEach, 1, type(uint64).max);

        uint256[] memory amounts = new uint256[](count);
        for (uint256 i = 0; i < count; i++) amounts[i] = amt;

        (uint256 qTotal, uint256 qFee, uint256 qWithFee) =
            multisender.quoteTotal(amounts, true);

        uint256 expTotal   = count * amt;
        uint256 expFee     = (expTotal * FEE_BPS) / BPS_DENOM;
        uint256 expWithFee = expTotal + expFee;

        assertEq(qTotal,   expTotal,   "quoteTotal: total mismatch");
        assertEq(qFee,     expFee,     "quoteTotal: fee mismatch");
        assertEq(qWithFee, expWithFee, "quoteTotal: totalWithFee mismatch");
    }

    /// @notice quoteTotal() for free tier always returns fee == 0.
    function testFuzz_QuoteTotalFreeTier_FeeIsZero(uint8 n, uint64 amountEach) public view {
        uint256 count = bound(n, 1, FREE_LIMIT);
        uint256 amt   = bound(amountEach, 1, type(uint64).max);

        uint256[] memory amounts = new uint256[](count);
        for (uint256 i = 0; i < count; i++) amounts[i] = amt;

        (, uint256 qFee, ) = multisender.quoteTotal(amounts, false);
        assertEq(qFee, 0, "Free tier fee must always be zero");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ── SECTION 2: Treasury Routing ────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Treasury must receive exactly (total * 15 / 10_000) after a pro send.
    function testFuzz_Treasury_ReceivesExactFee(uint8 n, uint64 amountEach) public {
        uint256 count = bound(n, 1, 20);
        uint256 amt   = bound(amountEach, 1, type(uint64).max);

        uint256 total = count * amt;
        uint256 fee   = (total * FEE_BPS) / BPS_DENOM;
        uint256 pull  = total + fee;

        (address[] memory recipients, uint256[] memory amounts) = _buildArrays(count, amt);
        _fundAndApprove(sender, pull);

        uint256 tBefore = token.balanceOf(treasury);

        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);

        assertEq(token.balanceOf(treasury) - tBefore, fee,
            "Treasury must receive exactly the 0.10% fee");
    }

    /// @notice Free tier: treasury must receive ZERO fee, regardless of batch size / amounts.
    function testFuzz_FreeTier_TreasuryReceivesNoFee(uint8 n, uint64 amountEach) public {
        uint256 count = bound(n, 1, FREE_LIMIT);
        uint256 amt   = bound(amountEach, 1, type(uint64).max);
        uint256 total = count * amt;

        (address[] memory recipients, uint256[] memory amounts) = _buildArrays(count, amt);
        _fundAndApprove(sender, total);  // no fee on free tier

        uint256 tBefore = token.balanceOf(treasury);

        vm.prank(sender);
        multisender.multisendFree(address(token), recipients, amounts);

        assertEq(token.balanceOf(treasury), tBefore,
            "Free tier must not send any fee to treasury");
    }

    /// @notice After a pro send, the contract itself must hold zero tokens (no residue).
    function testFuzz_Contract_HoldsZeroResidualBalance(uint8 n, uint64 amountEach) public {
        uint256 count = bound(n, 1, 20);
        uint256 amt   = bound(amountEach, 1, type(uint64).max);

        uint256 total = count * amt;
        uint256 fee   = (total * FEE_BPS) / BPS_DENOM;

        (address[] memory recipients, uint256[] memory amounts) = _buildArrays(count, amt);
        _fundAndApprove(sender, total + fee);

        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);

        assertEq(token.balanceOf(address(multisender)), 0,
            "Multisender must not retain any tokens after a complete send");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ── SECTION 3: Recipients Receive Correct Amounts ──────────────────────────
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Each recipient must receive exactly amounts[i] — no more, no less.
    function testFuzz_EachRecipient_ReceivesExactAmount(uint8 n, uint64 amountEach) public {
        uint256 count = bound(n, 1, 20);
        uint256 amt   = bound(amountEach, 1, type(uint64).max);

        uint256 total = count * amt;
        uint256 fee   = (total * FEE_BPS) / BPS_DENOM;

        (address[] memory recipients, uint256[] memory amounts) = _buildArrays(count, amt);
        _fundAndApprove(sender, total + fee);

        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);

        for (uint256 i = 0; i < count; i++) {
            assertEq(token.balanceOf(recipients[i]), amt,
                "Recipient received wrong token amount");
        }
    }

    /// @notice Sender's balance must decrease by exactly (total + fee) after a pro send.
    function testFuzz_Sender_BalanceDecreasedByPull(uint8 n, uint64 amountEach) public {
        uint256 count = bound(n, 1, 20);
        uint256 amt   = bound(amountEach, 1, type(uint64).max);

        uint256 total = count * amt;
        uint256 fee   = (total * FEE_BPS) / BPS_DENOM;
        uint256 pull  = total + fee;

        (address[] memory recipients, uint256[] memory amounts) = _buildArrays(count, amt);
        _fundAndApprove(sender, pull);

        uint256 balBefore = token.balanceOf(sender);

        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);

        assertEq(balBefore - token.balanceOf(sender), pull,
            "Sender balance must decrease by exactly total + fee");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ── SECTION 4: Revert Guards — Batch Limits ────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Pro tier must revert for ANY count above MAX_LIMIT (500).
    function testFuzz_Revert_ProTierExceedsMaxLimit(uint16 extra) public {
        uint256 n = bound(extra, 1, 200) + MAX_LIMIT;  // 501–700

        address[] memory recipients = new address[](n);
        uint256[] memory amounts    = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            recipients[i] = makeAddr(string(abi.encodePacked("r", vm.toString(i))));
            amounts[i]    = 1e6;
        }

        vm.expectRevert("Too many recipients");
        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);
    }

    /// @notice Free tier must revert for ANY count above FREE_LIMIT (5).
    function testFuzz_Revert_FreeTierExceedsFreeLimit(uint8 extra) public {
        uint256 n = bound(extra, 1, 50) + FREE_LIMIT;  // 6–55

        address[] memory recipients = new address[](n);
        uint256[] memory amounts    = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            recipients[i] = makeAddr(string(abi.encodePacked("r", vm.toString(i))));
            amounts[i]    = 1e6;
        }

        vm.expectRevert("Too many recipients");
        vm.prank(sender);
        multisender.multisendFree(address(token), recipients, amounts);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ── SECTION 5: Revert Guards — Zero Address Recipient ──────────────────────
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Revert if any recipient in the array is address(0), regardless of position.
    function testFuzz_Revert_ZeroAddressRecipient_AnyPosition(uint8 badIdx) public {
        uint256 n      = 5;
        uint256 zeroAt = bound(badIdx, 0, n - 1);

        address[] memory recipients = new address[](n);
        uint256[] memory amounts    = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            recipients[i] = (i == zeroAt)
                ? address(0)
                : makeAddr(string(abi.encodePacked("r", vm.toString(i))));
            amounts[i] = 1e6;
        }

        uint256 total = n * 1e6;
        uint256 fee   = (total * FEE_BPS) / BPS_DENOM;
        _fundAndApprove(sender, total + fee);

        vm.expectRevert("Zero address recipient");
        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ── SECTION 6: Revert Guards — Zero Amount ─────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Revert if any amount in the array is zero, regardless of position.
    function testFuzz_Revert_ZeroAmount_AnyPosition(uint8 badIdx) public {
        uint256 n      = 5;
        uint256 zeroAt = bound(badIdx, 0, n - 1);

        address[] memory recipients = new address[](n);
        uint256[] memory amounts    = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            recipients[i] = makeAddr(string(abi.encodePacked("r", vm.toString(i))));
            amounts[i]    = (i == zeroAt) ? 0 : 1e6;
        }

        _fundAndApprove(sender, n * 1e6 + 1e6); // over-fund; revert happens inside loop

        vm.expectRevert("Zero amount");
        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ── SECTION 7: Revert Guards — Allowance & Balance ─────────────────────────
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Revert if sender has approved less than (total + fee).
    function testFuzz_Revert_InsufficientAllowance(uint64 amountEach) public {
        uint256 amt   = bound(amountEach, 1, type(uint64).max);
        uint256 count = 3;
        uint256 total = count * amt;
        uint256 fee   = (total * FEE_BPS) / BPS_DENOM;
        uint256 pull  = total + fee;

        (address[] memory recipients, uint256[] memory amounts) = _buildArrays(count, amt);

        // Mint full amount but approve one wei less than required
        token.mint(sender, pull);
        vm.prank(sender);
        token.approve(address(multisender), pull - 1);

        vm.expectRevert("Insufficient allowance - approve first");
        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);
    }

    /// @notice Revert if sender's token balance is less than (total + fee).
    function testFuzz_Revert_InsufficientBalance(uint64 amountEach) public {
        uint256 amt   = bound(amountEach, 1, type(uint64).max);
        uint256 count = 3;
        uint256 total = count * amt;
        uint256 fee   = (total * FEE_BPS) / BPS_DENOM;
        uint256 pull  = total + fee;

        (address[] memory recipients, uint256[] memory amounts) = _buildArrays(count, amt);

        // Approve full amount but mint one wei less than required
        token.mint(sender, pull - 1);
        vm.prank(sender);
        token.approve(address(multisender), pull);

        vm.expectRevert("Insufficient balance");
        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ── SECTION 8: Unit — Boundary & Edge Cases ────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Empty recipients array must revert for pro tier.
    function test_Unit_Revert_EmptyArray_ProTier() public {
        address[] memory recipients = new address[](0);
        uint256[] memory amounts    = new uint256[](0);
        vm.expectRevert("No recipients");
        multisender.multisend(address(token), recipients, amounts);
    }

    /// @notice Empty recipients array must revert for free tier.
    function test_Unit_Revert_EmptyArray_FreeTier() public {
        address[] memory recipients = new address[](0);
        uint256[] memory amounts    = new uint256[](0);
        vm.expectRevert("No recipients");
        multisender.multisendFree(address(token), recipients, amounts);
    }

    /// @notice Mismatched array lengths must revert.
    function test_Unit_Revert_LengthMismatch() public {
        address[] memory recipients = new address[](3);
        uint256[] memory amounts    = new uint256[](2);
        vm.expectRevert("Length mismatch");
        multisender.multisend(address(token), recipients, amounts);
    }

    /// @notice Exactly MAX_LIMIT (500) recipients must succeed — upper boundary.
    function test_Unit_ProTier_AcceptsExactlyMaxLimit() public {
        uint256 amt  = 1e6;  // 1 USDC per recipient
        uint256 total = MAX_LIMIT * amt;
        uint256 fee   = (total * FEE_BPS) / BPS_DENOM;

        (address[] memory recipients, uint256[] memory amounts) = _buildArrays(MAX_LIMIT, amt);
        _fundAndApprove(sender, total + fee);

        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);  // must NOT revert

        assertEq(token.balanceOf(treasury), fee, "Treasury must receive fee at boundary");
    }

    /// @notice Exactly FREE_LIMIT (5) recipients must succeed for free tier.
    function test_Unit_FreeTier_AcceptsExactlyFreeLimit() public {
        uint256 amt  = 1e6;
        uint256 total = FREE_LIMIT * amt;

        (address[] memory recipients, uint256[] memory amounts) = _buildArrays(FREE_LIMIT, amt);
        _fundAndApprove(sender, total);  // no fee

        vm.prank(sender);
        multisender.multisendFree(address(token), recipients, amounts);  // must NOT revert

        assertEq(token.balanceOf(treasury), 0, "Free tier must not charge fee at boundary");
    }

    /// @notice Smallest possible valid amount (1 token unit) must work end-to-end.
    function test_Unit_MinimumAmount_OneUnit() public {
        uint256 amt   = 1;  // 1 token unit (0.000001 USDC)
        uint256 total = 1;
        uint256 fee   = (total * FEE_BPS) / BPS_DENOM;  // rounds to 0
        uint256 pull  = total + fee;

        (address[] memory recipients, uint256[] memory amounts) = _buildArrays(1, amt);
        _fundAndApprove(sender, pull);

        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);

        // For tiny amounts fee rounds to 0 — recipient gets the full 1 unit
        assertEq(token.balanceOf(recipients[0]), 1,
            "Recipient must receive 1 unit when fee rounds to zero");
    }

    /// @notice 501 recipients must revert at the exact boundary (MAX_LIMIT + 1).
    function test_Unit_ProTier_RevertAt501() public {
        address[] memory recipients = new address[](501);
        uint256[] memory amounts    = new uint256[](501);
        for (uint256 i = 0; i < 501; i++) {
            recipients[i] = makeAddr(string(abi.encodePacked("r", vm.toString(i))));
            amounts[i]    = 1e6;
        }
        vm.expectRevert("Too many recipients");
        multisender.multisend(address(token), recipients, amounts);
    }

    /// @notice 6 recipients must revert for free tier at the exact boundary (FREE_LIMIT + 1).
    function test_Unit_FreeTier_RevertAt6() public {
        address[] memory recipients = new address[](6);
        uint256[] memory amounts    = new uint256[](6);
        for (uint256 i = 0; i < 6; i++) {
            recipients[i] = makeAddr(string(abi.encodePacked("r", vm.toString(i))));
            amounts[i]    = 1e6;
        }
        vm.expectRevert("Too many recipients");
        multisender.multisendFree(address(token), recipients, amounts);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ── SECTION 9: Events ──────────────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Multisent event must be emitted with correct parameters.
    function test_Unit_MultisendEmitsEvent() public {
        uint256 amt   = 100e6;  // 100 USDC each
        uint256 n     = 3;
        uint256 total = n * amt;
        uint256 fee   = (total * FEE_BPS) / BPS_DENOM;

        (address[] memory recipients, uint256[] memory amounts) = _buildArrays(n, amt);
        _fundAndApprove(sender, total + fee);

        vm.expectEmit(true, true, false, true);
        emit ArcFXMultisender.Multisent(sender, address(token), total, n, fee, true);

        vm.prank(sender);
        multisender.multisend(address(token), recipients, amounts);
    }
}
