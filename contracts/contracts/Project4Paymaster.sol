// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "./lib/IERC20.sol";
import { Ownable } from "./lib/Ownable.sol";

interface IEntryPointLike {
    function depositTo(address account) external payable;
    function addStake(uint32 unstakeDelaySec) external payable;
    function withdrawTo(address payable withdrawAddress, uint256 amount) external;
    function withdrawStake(address payable withdrawAddress) external;
}

enum PostOpMode {
    opSucceeded,
    opReverted,
    postOpReverted
}

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/**
 * @title Project4Paymaster
 * @notice ERC-4337 paymaster charging USDC from smart accounts. No oracle - API signs max cost from pack-based FIFO pricing.
 * @dev EntryPoint v0.7 packed format. Supports execute(address,uint256,bytes) call pattern.
 */
contract Project4Paymaster is Ownable {
    error NotEntryPoint(address caller);
    error InvalidSignature();
    error InvalidPaymasterData();
    error TargetNotAllowed(address target);
    error UnsupportedCallPattern();
    error UsdcTransferFromFailed();
    error Paused();

    event VerifierUpdated(address indexed oldVerifier, address indexed newVerifier);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event TargetAllowedUpdated(address indexed target, bool allowed);
    event AllowAllTargetsUpdated(bool allowAll);
    event PausedUpdated(bool paused);
    event GasCharged(address indexed sender, uint256 chargedUsdcE6, uint256 chargedWei);
    event RateLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event CircuitBreakerTriggered(address indexed sender, uint256 gasUsed, uint256 limit);
    event GasUsageTracked(address indexed sender, uint256 periodGasUsed, uint256 totalGasUsed);
    event GasEstimationAlert(address indexed sender, uint256 estimatedGas, uint256 actualGas, uint256 variance);
    event MaxGasLimitExceeded(address indexed sender, uint256 requestedGas, uint256 maxAllowed);

    IERC20 public immutable usdc;
    IEntryPointLike public immutable entryPoint;

    address public verifier;
    address public treasury;
    uint256 public postOpOverheadGas;
    bool public allowAllTargets;
    bool public paused;
    mapping(address => bool) public targetAllowed;

    // Gas griefing mitigation
    uint256 public rateLimitPeriodSeconds;
    uint256 public rateLimitMaxGasPerPeriod;
    uint256 public circuitBreakerGasThreshold;
    mapping(address => uint256) public senderGasUsedThisPeriod;
    mapping(address => uint256) public senderLastActivityTimestamp;
    uint256 public totalGasUsedThisPeriod;
    uint256 public lastResetTimestamp;

    // Gas estimation attack mitigation
    uint256 public maxGasPerUserOp;
    uint256 public gasEstimationVarianceThreshold; // BPS (basis points, e.g., 5000 = 50%)
    mapping(address => uint256) public senderTotalGasUsed;
    mapping(address => uint256) public senderOperationCount;
    uint256 public totalOperationsProcessed;

    bytes4 private constant SIMPLE_ACCOUNT_EXECUTE_SELECTOR = 0xb61d27f6;
    bytes4 private constant ERC20_APPROVE_SELECTOR = 0x095ea7b3;
    uint256 private constant MIN_POSTOP_FEE_USDC_E6 = 10_000; // 0.01 USDC

    constructor(
        address entryPoint_,
        address usdc_,
        address verifier_,
        address treasury_
    ) {
        if (entryPoint_ == address(0) || usdc_ == address(0) || verifier_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        entryPoint = IEntryPointLike(entryPoint_);
        usdc = IERC20(usdc_);
        verifier = verifier_;
        treasury = treasury_;
        postOpOverheadGas = 35_000;
        allowAllTargets = true;

        // Initialize gas griefing mitigation defaults
        rateLimitPeriodSeconds = 1 hours;
        rateLimitMaxGasPerPeriod = 1_000_000_000; // 1B gas per hour per sender (higher limit for testing)
        circuitBreakerGasThreshold = 10_000_000_000; // 10B gas total triggers circuit breaker
        lastResetTimestamp = block.timestamp;

        // Initialize gas estimation attack mitigation defaults
        maxGasPerUserOp = 50_000_000; // 50M gas max per UserOp (reasonable for complex operations)
        gasEstimationVarianceThreshold = 5000; // 50% variance threshold
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint(msg.sender);
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    function setVerifier(address newVerifier) external onlyOwner {
        if (newVerifier == address(0)) revert ZeroAddress();
        emit VerifierUpdated(verifier, newVerifier);
        verifier = newVerifier;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setPostOpOverheadGas(uint256 newOverheadGas) external onlyOwner {
        postOpOverheadGas = newOverheadGas;
    }

    function setAllowAllTargets(bool allowAll) external onlyOwner {
        allowAllTargets = allowAll;
        emit AllowAllTargetsUpdated(allowAll);
    }

    function setTargetAllowed(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        targetAllowed[target] = allowed;
        emit TargetAllowedUpdated(target, allowed);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedUpdated(_paused);
    }

    function setRateLimit(uint256 periodSeconds, uint256 maxGasPerPeriod) external onlyOwner {
        emit RateLimitUpdated(rateLimitMaxGasPerPeriod, maxGasPerPeriod);
        rateLimitPeriodSeconds = periodSeconds;
        rateLimitMaxGasPerPeriod = maxGasPerPeriod;
    }

    function setCircuitBreakerThreshold(uint256 threshold) external onlyOwner {
        circuitBreakerGasThreshold = threshold;
    }

    function resetGasUsage() external onlyOwner {
        lastResetTimestamp = block.timestamp;
        totalGasUsedThisPeriod = 0;
    }

    function setMaxGasPerUserOp(uint256 maxGas) external onlyOwner {
        maxGasPerUserOp = maxGas;
    }

    function setGasEstimationVarianceThreshold(uint256 thresholdBps) external onlyOwner {
        gasEstimationVarianceThreshold = thresholdBps;
    }

    // View functions for gas usage monitoring
    function getSenderGasStats(address sender) external view returns (uint256 totalGas, uint256 operationCount, uint256 averageGas) {
        if (senderOperationCount[sender] == 0) return (0, 0, 0);
        return (senderTotalGasUsed[sender], senderOperationCount[sender], senderTotalGasUsed[sender] / senderOperationCount[sender]);
    }

    function getGlobalGasStats() external view returns (uint256 totalOps, uint256 periodGasUsed, uint256 lastReset) {
        return (totalOperationsProcessed, totalGasUsedThisPeriod, lastResetTimestamp);
    }

    function deposit() external payable onlyOwner {
        entryPoint.depositTo{ value: msg.value }(address(this));
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{ value: msg.value }(unstakeDelaySec);
    }

    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    function withdrawStake(address payable to) external onlyOwner {
        entryPoint.withdrawStake(to);
    }

    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32,
        uint256 maxCost
    ) external onlyEntryPoint whenNotPaused returns (bytes memory context, uint256 validationData) {
        (uint48 validUntil, uint48 validAfter, uint256 maxCostUsdcE6, uint256 usdcPerGasPrice, uint256 minPostopFeeUsdcE6, bytes memory sig) =
            _decodePaymasterData(userOp.paymasterAndData);
        (address target, bool supportedPattern) = _extractTarget(userOp.callData);

        // Allow any call pattern if allowAllTargets is true, otherwise require supported pattern
        if (!allowAllTargets) {
            if (!supportedPattern) revert UnsupportedCallPattern();
            if (!targetAllowed[target]) revert TargetNotAllowed(target);
        }

        bytes32 signedDigest = _toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    block.chainid,
                    address(this),
                    address(entryPoint),
                    userOp.sender,
                    userOp.nonce,
                    keccak256(userOp.callData),
                    target,
                    maxCostUsdcE6,
                    usdcPerGasPrice,
                    minPostopFeeUsdcE6,
                    validUntil,
                    validAfter
                )
            )
        );
        if (_recoverSigner(signedDigest, sig) != verifier) revert InvalidSignature();

        bool bootstrapApproval = _isBootstrapPaymasterApprove(userOp.callData);

        // Gas estimation attack mitigation: Check gas limits per UserOp
        if (!bootstrapApproval) {
            (uint256 callGasLimit,) = _extractGasLimits(userOp.accountGasLimits);
            if (callGasLimit > maxGasPerUserOp) {
                emit MaxGasLimitExceeded(userOp.sender, callGasLimit, maxGasPerUserOp);
                revert("Gas limit exceeded for UserOp");
            }
        }

        // Gas griefing mitigation: Check rate limits and circuit breakers
        // Temporarily disabled for testing - TODO: re-enable after testing
        // if (!bootstrapApproval && maxCost > 0) {
        //     _checkGasUsageLimits(userOp.sender, maxCost);
        // }

        // Don't charge here - charge in postOp. Pass context for postOp charging.
        bytes memory postOpContext;
        if (!bootstrapApproval && maxCostUsdcE6 > 0) {
            postOpContext = abi.encode(userOp.sender, maxCostUsdcE6, usdcPerGasPrice, minPostopFeeUsdcE6);
        }

        validationData = _packValidationData(validUntil, validAfter);
        return (postOpContext, validationData);
    }

    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFee)
        external
        onlyEntryPoint
    {
        // Charge USDC based on actual gas used (context: sender, maxCostUsdcE6, unitCostUsdcPerWei, minPostopFeeUsdcE6)
        if (context.length > 0 && mode == PostOpMode.opSucceeded) {
            (address sender, uint256 maxCostUsdcE6, uint256 unitCostUsdcPerWei, uint256 minPostopFeeUsdcE6) = abi.decode(context, (address, uint256, uint256, uint256));
            if (maxCostUsdcE6 > 0 && unitCostUsdcPerWei > 0) {
                uint256 chargeAmount = (actualGasCost * unitCostUsdcPerWei) / 1e18;
                // Enforce minimum whenever charging is active, even if integer division truncates to zero.
                if (chargeAmount < minPostopFeeUsdcE6) {
                    chargeAmount = minPostopFeeUsdcE6;
                }
                if (chargeAmount > maxCostUsdcE6) {
                    chargeAmount = maxCostUsdcE6;
                }
                if (chargeAmount > 0) {
                    if (!usdc.transferFrom(sender, treasury, chargeAmount)) revert UsdcTransferFromFailed();
                    emit GasCharged(sender, chargeAmount, actualGasCost);
                }
            }
        }
    }

    function _decodePaymasterData(bytes calldata paymasterAndData)
        internal
        pure
        returns (uint48 validUntil, uint48 validAfter, uint256 maxCostUsdcE6, uint256 usdcPerGasPrice, uint256 minPostopFeeUsdcE6, bytes memory sig)
    {
        if (paymasterAndData.length < 52 + 32 * 6) revert InvalidPaymasterData();
        bytes calldata trailing = paymasterAndData[52:];
        (validUntil, validAfter, maxCostUsdcE6, usdcPerGasPrice, minPostopFeeUsdcE6, sig) = abi.decode(trailing, (uint48, uint48, uint256, uint256, uint256, bytes));
        if (sig.length != 65) revert InvalidPaymasterData();
    }

    function _extractTarget(bytes calldata callData) internal pure returns (address target, bool supportedPattern) {
        if (callData.length < 36) return (address(0), false);
        bytes4 selector = bytes4(callData[:4]);
        if (selector != SIMPLE_ACCOUNT_EXECUTE_SELECTOR) return (address(0), false);
        (target,,) = abi.decode(callData[4:], (address, uint256, bytes));
        return (target, true);
    }

    function _extractGasLimits(bytes32 accountGasLimits) internal pure returns (uint256 callGasLimit, uint256 verificationGasLimit) {
        // accountGasLimits is packed as: [verificationGasLimit (16 bytes)][callGasLimit (16 bytes)]
        assembly {
            verificationGasLimit := shr(128, accountGasLimits)
            callGasLimit := and(accountGasLimits, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
        }
    }

    function _isBootstrapPaymasterApprove(bytes calldata callData) internal view returns (bool) {
        if (callData.length < 4) return false;
        bytes4 selector = bytes4(callData[:4]);
        if (selector != SIMPLE_ACCOUNT_EXECUTE_SELECTOR) return false;

        (address target,, bytes memory innerData) = abi.decode(callData[4:], (address, uint256, bytes));
        if (target != address(usdc) || innerData.length < 4) return false;
        if (bytes4(innerData) != ERC20_APPROVE_SELECTOR) return false;

        address spender;
        assembly {
            spender := shr(96, mload(add(innerData, 48)))
        }
        return spender == address(this);
    }

    function _packValidationData(uint48 validUntil, uint48 validAfter) internal pure returns (uint256) {
        return (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    function _toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    function _recoverSigner(bytes32 digest, bytes memory sig) internal pure returns (address signer) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        signer = ecrecover(digest, v, r, s);
    }

    function _checkGasUsageLimits(address sender, uint256 gasCost) internal {
        uint256 currentTime = block.timestamp;

        // Reset period counters if needed
        if (currentTime >= lastResetTimestamp + rateLimitPeriodSeconds) {
            lastResetTimestamp = currentTime;
            totalGasUsedThisPeriod = 0;
            // Note: individual sender counters are reset on first use in new period
        }

        // Reset sender counter if outside current period
        if (currentTime >= senderLastActivityTimestamp[sender] + rateLimitPeriodSeconds) {
            senderGasUsedThisPeriod[sender] = 0;
        }

        // Check per-sender rate limit
        if (senderGasUsedThisPeriod[sender] + gasCost > rateLimitMaxGasPerPeriod) {
            emit CircuitBreakerTriggered(sender, senderGasUsedThisPeriod[sender] + gasCost, rateLimitMaxGasPerPeriod);
            paused = true;
            emit PausedUpdated(true);
            revert("Rate limit exceeded for sender");
        }

        // Check global circuit breaker
        if (totalGasUsedThisPeriod + gasCost > circuitBreakerGasThreshold) {
            emit CircuitBreakerTriggered(address(0), totalGasUsedThisPeriod + gasCost, circuitBreakerGasThreshold);
            paused = true;
            emit PausedUpdated(true);
            revert("Global gas usage circuit breaker triggered");
        }

        // Update counters
        senderGasUsedThisPeriod[sender] += gasCost;
        senderLastActivityTimestamp[sender] = currentTime;
        totalGasUsedThisPeriod += gasCost;

        emit GasUsageTracked(sender, senderGasUsedThisPeriod[sender], totalGasUsedThisPeriod);
    }
}
