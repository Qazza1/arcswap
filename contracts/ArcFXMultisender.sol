// SPDX-License-Identifier: MIT
pragma solidity 0.8.35; // L-01: pinned version — no floating ^ (original was ^0.8.20)

/**
 * ArcFXMultisender — Send USDC/EURC to multiple wallets in one transaction.
 *
 * Free tier:   up to 5 recipients, no fee
 * Pro tier:    up to 500 recipients, 0.10% protocol fee
 *
 * Deployed on Arc Testnet by ArcFX (arcfx.app)
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

contract ArcFXMultisender {

    // ── State ─────────────────────────────────────────────────────────────────

    address public owner;
    address public treasury;             // collects protocol fees

    uint256 public constant FREE_LIMIT   = 5;       // max recipients on free tier
    uint256 public constant MAX_LIMIT    = 500;     // max recipients on pro tier
    uint256 public constant FEE_BPS      = 10;      // 0.10% = 10 basis points
    uint256 public constant BPS_DENOM    = 10_000;  // basis point denominator
    // Math: fee = (total * 10) / 10_000 — multiply before divide prevents precision loss

    // ── Events ────────────────────────────────────────────────────────────────

    event Multisent(
        address indexed sender,
        address indexed token,
        uint256 totalAmount,
        uint256 recipientCount,
        uint256 fee,
        bool    isPro
    );

    event OwnershipTransferred(address indexed previous, address indexed next);
    event TreasuryUpdated(address indexed previous, address indexed next);

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

    // ── Main Functions ────────────────────────────────────────────────────────

    /**
     * Free tier: send to up to 5 recipients, no fee.
     */
    function multisendFree(
        address         token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        _validateInputs(recipients, amounts, FREE_LIMIT);
        _execute(token, recipients, amounts, false);
    }

    /**
     * Pro tier: send to up to 500 recipients.
     * A 0.10% protocol fee is added on top of the total amount.
     */
    function multisend(
        address         token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        _validateInputs(recipients, amounts, MAX_LIMIT);
        _execute(token, recipients, amounts, true);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _validateInputs(
        address[] calldata recipients,
        uint256[] calldata amounts,
        uint256 maxLen
    ) internal pure {
        require(recipients.length > 0,                        "No recipients");
        require(recipients.length <= maxLen,                  "Too many recipients");
        require(recipients.length == amounts.length,          "Length mismatch");
    }

    function _execute(
        address         token,
        address[] calldata recipients,
        uint256[] calldata amounts,
        bool    isPro
    ) internal {
        IERC20 erc20 = IERC20(token);

        // Sum total
        uint256 total = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            require(recipients[i] != address(0), "Zero address recipient");
            require(amounts[i] > 0,              "Zero amount");
            total += amounts[i];
        }

        // Fee (pro only)
        uint256 fee = isPro ? (total * FEE_BPS) / BPS_DENOM : 0;
        uint256 pull = total + fee;

        // Pull tokens from sender (must have approved this contract first)
        require(
            erc20.allowance(msg.sender, address(this)) >= pull,
            "Insufficient allowance - approve first"
        );
        require(
            erc20.balanceOf(msg.sender) >= pull,
            "Insufficient balance"
        );

        // H-02: CEI pattern — emit event before external interactions.
        // If any subsequent transfer reverts, the entire transaction (including
        // this event) is rolled back, so no phantom events are ever recorded.
        emit Multisent(msg.sender, token, total, recipients.length, fee, isPro);

        bool ok = erc20.transferFrom(msg.sender, address(this), pull);
        require(ok, "TransferFrom failed");

        // Distribute — M-01: each transfer is wrapped in require() so the
        // whole batch reverts cleanly on any single failure (intended behaviour
        // for a B2B payroll tool where partial settlement is unacceptable).
        for (uint256 i = 0; i < recipients.length; i++) {
            bool sent = erc20.transfer(recipients[i], amounts[i]);
            require(sent, "Transfer to recipient failed");
        }

        // Send protocol fee to treasury
        if (fee > 0) {
            bool feeSent = erc20.transfer(treasury, fee);
            require(feeSent, "Fee transfer failed");
        }
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setTreasury(address newTreasury) external onlyOwner { // L-02: mixedCase param
        require(newTreasury != address(0), "Invalid treasury address");
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function transferOwnership(address newOwner) external onlyOwner { // L-02: mixedCase param
        require(newOwner != address(0), "Invalid address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /**
     * Emergency: recover any tokens accidentally sent directly to the contract.
     */
    function emergencyWithdraw(address token) external onlyOwner {
        IERC20 erc20 = IERC20(token);
        uint256 bal  = erc20.balanceOf(address(this));
        require(bal > 0, "Nothing to withdraw");
        require(erc20.transfer(owner, bal), "Withdraw failed"); // H-01: checked return value
    }

    // ── View helpers ──────────────────────────────────────────────────────────

    /**
     * Calculate the total amount needed (including fee) for a given recipients list.
     */
    function quoteTotal(uint256[] calldata amounts, bool isPro)
        external pure returns (uint256 total, uint256 fee, uint256 totalWithFee)
    {
        for (uint256 i = 0; i < amounts.length; i++) {
            total += amounts[i];
        }
        fee          = isPro ? (total * FEE_BPS) / BPS_DENOM : 0;
        totalWithFee = total + fee;
    }
}
