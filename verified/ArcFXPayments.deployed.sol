// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ArcFXPayments — On-chain settlement for Pay Links and Invoices.
 *
 * Any payer can call `pay()` with a payment reference (invoiceId / pay link ID).
 * A 0.15% protocol fee (15 bps) is deducted and routed to the ArcFX treasury.
 * The remainder goes directly to the recipient.
 *
 * Designed for USDC and EURC (6-decimal ERC-20 stablecoins) on Arc Testnet.
 *
 * Deployed by ArcFX (arcfx.app)
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

contract ArcFXPayments {

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 public constant FEE_BPS   = 15;       // 0.15% = 15 basis points
    uint256 public constant BPS_DENOM = 10_000;

    // Fee math (for USDC with 6 decimals):
    //   gross = 1000 USDC = 1_000_000_000 units
    //   fee   = (1_000_000_000 * 15) / 10_000 = 1_500_000 units = 1.5 USDC ✓
    //   net   = 1_000_000_000 - 1_500_000 = 998_500_000 = 998.5 USDC
    //
    // Multiply-before-divide pattern: no precision loss for amounts ≥ 667 units

    // ── State ─────────────────────────────────────────────────────────────────

    address public owner;
    address public treasury;    // receives the 0.15% protocol fee

    // ── Events ────────────────────────────────────────────────────────────────

    /**
     * Emitted on every successful payment.
     *
     * @param paymentId   Off-chain reference (invoice number, pay link ID, etc.)
     * @param payer       Address that sent the payment
     * @param recipient   Address that received net amount
     * @param token       ERC-20 token used (USDC or EURC)
     * @param gross       Total amount payer approved
     * @param fee         Protocol fee routed to treasury (0.15% of gross)
     * @param net         Amount received by recipient (gross - fee)
     */
    event PaymentExecuted(
        bytes32 indexed paymentId,
        address indexed payer,
        address indexed recipient,
        address         token,
        uint256         gross,
        uint256         fee,
        uint256         net
    );

    event TreasuryUpdated(address indexed previous, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _treasury) {
        require(_treasury != address(0), "Invalid treasury address");
        owner    = msg.sender;
        treasury = _treasury;
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // ── Core: Pay ─────────────────────────────────────────────────────────────

    /**
     * Execute a payment.
     *
     * The payer must approve this contract for `gross` tokens before calling.
     * Fee is deducted from gross — recipient receives (gross - fee).
     *
     * @param token       USDC or EURC contract address
     * @param recipient   Who receives the payment (invoice creator, merchant)
     * @param gross       Total amount in token units (including protocol fee)
     * @param paymentId   Off-chain reference: keccak256 of invoice number or pay link ID
     */
    function pay(
        address token,
        address recipient,
        uint256 gross,
        bytes32 paymentId
    ) external {
        // ── Validate ─────────────────────────────────────────────────────────
        require(token     != address(0), "Invalid token");
        require(recipient != address(0), "Invalid recipient");
        require(gross      > 0,          "Amount must be > 0");
        require(paymentId != bytes32(0), "Invalid payment ID");
        require(recipient != msg.sender, "Cannot pay yourself");

        IERC20 erc20 = IERC20(token);

        require(
            erc20.allowance(msg.sender, address(this)) >= gross,
            "Insufficient allowance - approve first"
        );
        require(
            erc20.balanceOf(msg.sender) >= gross,
            "Insufficient balance"
        );

        // ── Fee calculation ───────────────────────────────────────────────────
        // Multiply before divide — no precision loss
        uint256 fee = (gross * FEE_BPS) / BPS_DENOM;
        uint256 net = gross - fee;

        require(net > 0, "Net amount too small");

        // ── Settlement ────────────────────────────────────────────────────────
        // Pull full gross from payer in one transferFrom
        bool pulled = erc20.transferFrom(msg.sender, address(this), gross);
        require(pulled, "TransferFrom failed");

        // Send net to recipient
        // Using low-level call pattern via interface for gas efficiency
        (bool sentToRecipient) = _safeTransfer(erc20, recipient, net);
        require(sentToRecipient, "Payment to recipient failed");

        // Send fee to treasury
        if (fee > 0) {
            bool sentFee = _safeTransfer(erc20, treasury, fee);
            require(sentFee, "Fee transfer failed");
        }

        // ── Emit ──────────────────────────────────────────────────────────────
        emit PaymentExecuted(
            paymentId,
            msg.sender,
            recipient,
            token,
            gross,
            fee,
            net
        );
    }

    // ── View helpers ──────────────────────────────────────────────────────────

    /**
     * Preview the fee and net amount for a given gross payment.
     * Call this before `pay()` to show the breakdown in the UI.
     *
     * @param gross   Total amount payer will approve (in token units)
     * @return fee    Protocol fee (0.15% of gross)
     * @return net    Amount recipient will receive (gross - fee)
     */
    function quoteFee(uint256 gross)
        external pure
        returns (uint256 fee, uint256 net)
    {
        fee = (gross * FEE_BPS) / BPS_DENOM;
        net = gross - fee;
    }

    /**
     * Build the paymentId from an off-chain string reference.
     * Convenience helper for frontends: keccak256(abi.encodePacked(ref))
     */
    function buildPaymentId(string calldata ref)
        external pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(ref));
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _safeTransfer(IERC20 token, address to, uint256 amount)
        internal returns (bool)
    {
        return token.transfer(to, amount);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setTreasury(address _new) external onlyOwner {
        require(_new != address(0), "Invalid treasury address");
        emit TreasuryUpdated(treasury, _new);
        treasury = _new;
    }

    function transferOwnership(address _new) external onlyOwner {
        require(_new != address(0), "Invalid address");
        emit OwnershipTransferred(owner, _new);
        owner = _new;
    }

    /**
     * Emergency: recover any tokens accidentally sent directly to this contract.
     */
    function emergencyWithdraw(address token) external onlyOwner {
        IERC20 erc20 = IERC20(token);
        uint256 bal  = erc20.balanceOf(address(this));
        require(bal > 0, "Nothing to withdraw");
        erc20.transfer(owner, bal);
    }
}
