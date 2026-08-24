// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import "forge-std/Test.sol";
import "../contracts/ArcFXPayments.sol";

// ===========================================================================
// MockERC20
// Minimal ERC-20 for testing. Tracks balances/allowances accurately and,
// unlike a well-behaved token, exposes a switch to return false from transfer
// so the contract's checked-return paths can be exercised.
// ===========================================================================

contract MockERC20 {
    string public name = "Mock USDC";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // When true, transfer() returns false instead of moving funds. Models the
    // non-standard "returns false rather than revert" tokens the require guards
    // are there to catch.
    bool public failTransfer;

    function setFailTransfer(bool v) external {
        failTransfer = v;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfer) return false;
        require(balanceOf[msg.sender] >= amount, "MockERC20: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "MockERC20: insufficient balance");
        require(allowance[from][msg.sender] >= amount, "MockERC20: insufficient allowance");
        balanceOf[from] -= amount;
        allowance[from][msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// ===========================================================================
// ArcFXPaymentsTest
// ===========================================================================

contract ArcFXPaymentsTest is Test {
    ArcFXPayments public payments;
    MockERC20 public token;

    address public owner;
    address public treasury;
    address public payer;
    address public recipient;

    // Mirror of the contract constants, so an assertion fails loudly if the
    // deployed rate ever drifts from what these tests were written against.
    uint256 constant FEE_BPS = 15;
    uint256 constant BPS_DENOM = 10_000;

    bytes32 constant PID = keccak256("invoice-0001");

    event PaymentExecuted(
        bytes32 indexed paymentId,
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 gross,
        uint256 fee,
        uint256 net
    );
    event TreasuryUpdated(address indexed previous, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    function setUp() public {
        owner = address(this);
        treasury = makeAddr("treasury");
        payer = makeAddr("payer");
        recipient = makeAddr("recipient");

        payments = new ArcFXPayments(treasury);
        token = new MockERC20();
    }

    // Fund the payer and approve the contract for `gross`.
    function _fund(uint256 gross) internal {
        token.mint(payer, gross);
        vm.prank(payer);
        token.approve(address(payments), gross);
    }

    function _expectedFee(uint256 gross) internal pure returns (uint256) {
        return (gross * FEE_BPS) / BPS_DENOM;
    }

    // ── Constructor ────────────────────────────────────────────────────────

    function test_Constructor_SetsOwnerAndTreasury() public view {
        assertEq(payments.owner(), owner, "owner");
        assertEq(payments.treasury(), treasury, "treasury");
        assertEq(payments.FEE_BPS(), FEE_BPS, "fee rate is 15 bps");
    }

    function test_Constructor_RevertZeroTreasury() public {
        vm.expectRevert("Invalid treasury address");
        new ArcFXPayments(address(0));
    }

    // ── Happy path ───────────────────────────────────────────────────────────

    function test_Pay_SplitsFeeAndNet() public {
        uint256 gross = 1_000_000_000; // 1000 USDC
        uint256 fee = _expectedFee(gross); // 1.5 USDC
        uint256 net = gross - fee;
        _fund(gross);

        vm.prank(payer);
        payments.pay(address(token), recipient, gross, PID);

        assertEq(token.balanceOf(recipient), net, "recipient gets net");
        assertEq(token.balanceOf(treasury), fee, "treasury gets fee");
        assertEq(token.balanceOf(payer), 0, "payer fully debited");
        // No dust left behind in the contract.
        assertEq(token.balanceOf(address(payments)), 0, "contract holds nothing");
        // Conservation.
        assertEq(net + fee, gross, "net + fee == gross");
    }

    function test_Pay_EmitsExecutedEvent() public {
        uint256 gross = 500_000_000;
        uint256 fee = _expectedFee(gross);
        uint256 net = gross - fee;
        _fund(gross);

        vm.expectEmit(true, true, true, true);
        emit PaymentExecuted(PID, payer, recipient, address(token), gross, fee, net);

        vm.prank(payer);
        payments.pay(address(token), recipient, gross, PID);
    }

    function test_Pay_QuoteMatchesSettlement() public {
        uint256 gross = 777_777_777;
        (uint256 qFee, uint256 qNet) = payments.quoteFee(gross);
        _fund(gross);

        vm.prank(payer);
        payments.pay(address(token), recipient, gross, PID);

        assertEq(token.balanceOf(treasury), qFee, "quoted fee matches");
        assertEq(token.balanceOf(recipient), qNet, "quoted net matches");
    }

    // ── Validation ─────────────────────────────────────────────────────────

    function test_Pay_RevertZeroToken() public {
        vm.prank(payer);
        vm.expectRevert("Invalid token");
        payments.pay(address(0), recipient, 1_000, PID);
    }

    function test_Pay_RevertZeroRecipient() public {
        vm.prank(payer);
        vm.expectRevert("Invalid recipient");
        payments.pay(address(token), address(0), 1_000, PID);
    }

    function test_Pay_RevertZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert("Amount must be > 0");
        payments.pay(address(token), recipient, 0, PID);
    }

    function test_Pay_RevertZeroPaymentId() public {
        vm.prank(payer);
        vm.expectRevert("Invalid payment ID");
        payments.pay(address(token), recipient, 1_000, bytes32(0));
    }

    function test_Pay_RevertPayYourself() public {
        uint256 gross = 1_000_000;
        _fund(gross);
        vm.prank(payer);
        vm.expectRevert("Cannot pay yourself");
        payments.pay(address(token), payer, gross, PID);
    }

    function test_Pay_RevertInsufficientAllowance() public {
        uint256 gross = 1_000_000;
        token.mint(payer, gross);
        // Approve less than gross.
        vm.prank(payer);
        token.approve(address(payments), gross - 1);

        vm.prank(payer);
        vm.expectRevert("Insufficient allowance - approve first");
        payments.pay(address(token), recipient, gross, PID);
    }

    function test_Pay_RevertInsufficientBalance() public {
        uint256 gross = 1_000_000;
        // Approve enough but never mint the balance.
        vm.prank(payer);
        token.approve(address(payments), gross);

        vm.prank(payer);
        vm.expectRevert("Insufficient balance");
        payments.pay(address(token), recipient, gross, PID);
    }

    // A token that returns false (rather than reverting) on transfer must not
    // let the payment appear to succeed. This is the whole point of the checked
    // returns the gas audit pushed back on removing.
    function test_Pay_RevertOnSilentTransferFailure() public {
        uint256 gross = 1_000_000;
        _fund(gross);
        token.setFailTransfer(true);

        vm.prank(payer);
        vm.expectRevert("Payment to recipient failed");
        payments.pay(address(token), recipient, gross, PID);
    }

    // ── Fee edge cases ───────────────────────────────────────────────────────

    // Below 667 units the 15-bps fee rounds down to zero. The recipient must
    // still receive the full gross and the treasury nothing — never a revert.
    function test_Pay_TinyAmount_FeeRoundsToZero() public {
        uint256 gross = 100; // (100 * 15) / 10000 == 0
        assertEq(_expectedFee(gross), 0, "fee rounds to zero");
        _fund(gross);

        vm.prank(payer);
        payments.pay(address(token), recipient, gross, PID);

        assertEq(token.balanceOf(recipient), gross, "recipient gets everything");
        assertEq(token.balanceOf(treasury), 0, "treasury gets nothing");
    }

    function test_Pay_OneUnit() public {
        uint256 gross = 1;
        _fund(gross);
        vm.prank(payer);
        payments.pay(address(token), recipient, gross, PID);
        assertEq(token.balanceOf(recipient), 1, "1 unit passes through");
        assertEq(token.balanceOf(treasury), 0, "no fee on 1 unit");
    }

    function test_QuoteFee_Pure() public view {
        (uint256 fee, uint256 net) = payments.quoteFee(1_000_000_000);
        assertEq(fee, 1_500_000, "1.5 USDC fee");
        assertEq(net, 998_500_000, "998.5 USDC net");
    }

    function test_BuildPaymentId_MatchesKeccak() public view {
        assertEq(payments.buildPaymentId("invoice-0001"), keccak256(abi.encodePacked("invoice-0001")));
    }

    // ── Admin ──────────────────────────────────────────────────────────────

    function test_SetTreasury_OnlyOwner() public {
        address next = makeAddr("treasury2");
        vm.expectEmit(true, true, false, true);
        emit TreasuryUpdated(treasury, next);
        payments.setTreasury(next);
        assertEq(payments.treasury(), next);
    }

    function test_SetTreasury_RevertNotOwner() public {
        vm.prank(payer);
        vm.expectRevert("Not owner");
        payments.setTreasury(payer);
    }

    function test_SetTreasury_RevertZero() public {
        vm.expectRevert("Invalid treasury address");
        payments.setTreasury(address(0));
    }

    function test_TransferOwnership() public {
        address next = makeAddr("owner2");
        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferred(owner, next);
        payments.transferOwnership(next);
        assertEq(payments.owner(), next);
    }

    function test_TransferOwnership_RevertNotOwner() public {
        vm.prank(payer);
        vm.expectRevert("Not owner");
        payments.transferOwnership(payer);
    }

    function test_EmergencyWithdraw_RecoversStrandedTokens() public {
        // Tokens sent directly to the contract, bypassing pay().
        token.mint(address(payments), 5_000);
        payments.emergencyWithdraw(address(token));
        assertEq(token.balanceOf(owner), 5_000, "owner recovers stranded tokens");
        assertEq(token.balanceOf(address(payments)), 0, "contract emptied");
    }

    function test_EmergencyWithdraw_RevertNothing() public {
        vm.expectRevert("Nothing to withdraw");
        payments.emergencyWithdraw(address(token));
    }

    function test_EmergencyWithdraw_RevertNotOwner() public {
        token.mint(address(payments), 1);
        vm.prank(payer);
        vm.expectRevert("Not owner");
        payments.emergencyWithdraw(address(token));
    }

    // ── Fuzz: the invariants that matter for a money contract ────────────────

    function testFuzz_Pay_ConservesValueAndLeavesNoDust(uint256 gross) public {
        // Bound to a realistic stablecoin range: 1 unit .. 100M tokens (6 dp).
        gross = bound(gross, 1, 100_000_000_000_000);
        _fund(gross);

        vm.prank(payer);
        payments.pay(address(token), recipient, gross, PID);

        uint256 fee = token.balanceOf(treasury);
        uint256 net = token.balanceOf(recipient);

        assertEq(fee, (gross * FEE_BPS) / BPS_DENOM, "fee is exactly 15 bps floored");
        assertEq(net + fee, gross, "value conserved");
        assertEq(token.balanceOf(address(payments)), 0, "no dust retained");
        assertLe(fee, gross / 100, "fee never exceeds 1% of gross");
    }
}
