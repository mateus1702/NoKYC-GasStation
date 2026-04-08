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
 * @notice ERC-4337 paymaster: API-signed USDC-per-wei quotes from procurement counters; postOp charges actualGasCost * usdcPerWeiE6 / 1e18.
 * @dev EntryPoint v0.7 packed format. No on-chain swaps; USDC withdraw for off-chain ops (owner only).
 */
contract Project4Paymaster is Ownable {
    error NotEntryPoint(address caller);
    error InvalidSignature();
    error InvalidPaymasterData();
    error ReferralBpsTooHigh(uint256 bps);
    error ReferralAddressZero();
    error TargetNotAllowed(address target);
    error UnsupportedCallPattern();
    error UsdcTransferFromFailed();
    error UsdcTransferFailed();
    error Paused();
    error InsufficientUserUsdcBalance(uint256 balance, uint256 required);

    uint8 public constant CAP_PROFILE_NORMAL = 0;
    uint8 public constant CAP_PROFILE_DEPLOY = 1;

    event VerifierUpdated(address indexed oldVerifier, address indexed newVerifier);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event TargetAllowedUpdated(address indexed target, bool allowed);
    event AllowAllTargetsUpdated(bool allowAll);
    event PausedUpdated(bool paused);
    event UsdcWithdrawn(address indexed to, uint256 amount, address indexed caller);
    event GasPurchaseRecorded(uint256 usdcE6, uint256 nativeWei);

    event GasCharged(
        address indexed sender,
        uint256 chargedUsdcE6,
        uint256 baseChargeUsdcE6,
        address treasury,
        uint256 gasUnits,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    );

    event GasChargedWithReferral(
        address indexed sender,
        uint256 baseChargeUsdcE6,
        uint256 referralChargeUsdcE6,
        uint256 totalChargeUsdcE6,
        address indexed referralAddress,
        uint256 referralBps,
        uint256 gasUnits,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    );

    event RateLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event CircuitBreakerTriggered(address indexed sender, uint256 gasUsed, uint256 limit);
    event GasUsageTracked(address indexed sender, uint256 periodGasUsed, uint256 totalGasUsed);

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

    // Per-sender stats (observed gas)
    /// @dev Legacy knob; not used in charging logic.
    uint256 public gasEstimationVarianceThreshold;
    mapping(address => uint256) public senderTotalGasUsed;
    mapping(address => uint256) public senderOperationCount;
    uint256 public totalOperationsProcessed;

    // Pricing counters (API reads for quotes; procurement updated via recordGasPurchase)
    uint256 public totalGasUnitsProcessed;
    uint256 public totalUsdcSpentForGasE6;
    uint256 public totalGasBoughtWei;

    bytes4 private constant SIMPLE_ACCOUNT_EXECUTE_SELECTOR = 0xb61d27f6;

    /// @dev 52-byte prefix + abi trailing (10*32 static + 32 len + 96 padded sig) = 52 + 448 = 500
    uint256 private constant PAYMASTER_AND_DATA_MIN_LENGTH = 500;
    uint256 private constant REFERRAL_BPS_MAX = 500;

    constructor(address entryPoint_, address usdc_, address verifier_, address treasury_) {
        if (entryPoint_ == address(0) || usdc_ == address(0) || verifier_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }

        entryPoint = IEntryPointLike(entryPoint_);
        usdc = IERC20(usdc_);
        verifier = verifier_;
        treasury = treasury_;
        postOpOverheadGas = 35_000;
        allowAllTargets = true;

        rateLimitPeriodSeconds = 1 hours;
        rateLimitMaxGasPerPeriod = 1_000_000_000;
        circuitBreakerGasThreshold = 10_000_000_000;
        lastResetTimestamp = block.timestamp;

        gasEstimationVarianceThreshold = 5000;
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

    function setGasEstimationVarianceThreshold(uint256 thresholdBps) external onlyOwner {
        gasEstimationVarianceThreshold = thresholdBps;
    }

    function getSenderGasStats(address sender)
        external
        view
        returns (uint256 totalGas, uint256 operationCount, uint256 averageGas)
    {
        if (senderOperationCount[sender] == 0) return (0, 0, 0);
        return (
            senderTotalGasUsed[sender],
            senderOperationCount[sender],
            senderTotalGasUsed[sender] / senderOperationCount[sender]
        );
    }

    function getGlobalGasStats() external view returns (uint256 totalOps, uint256 periodGasUsed, uint256 lastReset) {
        return (totalOperationsProcessed, totalGasUsedThisPeriod, lastResetTimestamp);
    }

    function getPricingCounters()
        external
        view
        returns (uint256 gasUnitsProcessed, uint256 usdcSpentForGasE6, uint256 gasBoughtWei)
    {
        return (totalGasUnitsProcessed, totalUsdcSpentForGasE6, totalGasBoughtWei);
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

    /// @notice Pull USDC held by this contract (e.g. after user settlement) to an off-chain ops wallet.
    function withdrawUsdc(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (!usdc.transfer(to, amount)) revert UsdcTransferFailed();
        emit UsdcWithdrawn(to, amount, msg.sender);
    }

    /// @notice Bookkeeping for off-chain USDC→native swaps (API calls after refill).
    function recordGasPurchase(uint256 usdcE6, uint256 nativeWei) external onlyOwner {
        totalUsdcSpentForGasE6 += usdcE6;
        totalGasBoughtWei += nativeWei;
        emit GasPurchaseRecorded(usdcE6, nativeWei);
    }

    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32,
        uint256
    ) external onlyEntryPoint whenNotPaused returns (bytes memory context, uint256 validationData) {
        (
            uint48 validUntil,
            uint48 validAfter,
            uint256 usdcPerWeiE6,
            uint256 minPostopFeeUsdcE6,
            uint256 estimatedNormalGasUnits,
            uint256 estimatedDeployGasUnits,
            address referralAddress,
            uint256 referralBps,
            uint8 capProfile,
            bytes memory sig
        ) = _decodePaymasterData(userOp.paymasterAndData);

        if (referralBps > REFERRAL_BPS_MAX) revert ReferralBpsTooHigh(referralBps);
        if (referralBps > 0 && referralAddress == address(0)) revert ReferralAddressZero();
        if (capProfile != CAP_PROFILE_NORMAL && capProfile != CAP_PROFILE_DEPLOY) revert InvalidPaymasterData();

        (address target, bool supportedPattern) = _extractTarget(userOp.callData);

        if (!allowAllTargets) {
            if (!supportedPattern) revert UnsupportedCallPattern();
            if (!targetAllowed[target]) revert TargetNotAllowed(target);
        }

        bytes32 signedDigest = _buildPaymasterDigest(
            userOp.sender,
            userOp.nonce,
            userOp.callData,
            target,
            usdcPerWeiE6,
            minPostopFeeUsdcE6,
            estimatedNormalGasUnits,
            estimatedDeployGasUnits,
            validUntil,
            validAfter,
            referralAddress,
            referralBps,
            capProfile
        );

        if (_recoverSigner(signedDigest, sig) != verifier) revert InvalidSignature();

        uint256 gasUnitsForReserve = userOp.initCode.length > 0 ? estimatedDeployGasUnits : estimatedNormalGasUnits;
        uint256 maxFeePerGas = _unpackMaxFeePerGas(userOp.gasFees);
        uint256 maxWeiForReserve = gasUnitsForReserve * maxFeePerGas;
        uint256 minRequiredUsdcE6 = (maxWeiForReserve * usdcPerWeiE6) / 1e18;
        uint256 bal = usdc.balanceOf(userOp.sender);
        if (bal < minRequiredUsdcE6) revert InsufficientUserUsdcBalance(bal, minRequiredUsdcE6);

        if (usdcPerWeiE6 > 0) {
            context = abi.encode(userOp.sender, usdcPerWeiE6, minPostopFeeUsdcE6, referralAddress, referralBps);
        }

        validationData = _packValidationData(validUntil, validAfter);
        return (context, validationData);
    }

    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external
        onlyEntryPoint
    {
        if (context.length == 0 || mode != PostOpMode.opSucceeded) return;

        (address sender, uint256 usdcPerWeiE6, uint256 minPostopFeeUsdcE6, address referralAddress, uint256 referralBps) =
            abi.decode(context, (address, uint256, uint256, address, uint256));

        if (usdcPerWeiE6 == 0) return;

        uint256 gasUnits;
        if (actualUserOpFeePerGas > 0) {
            gasUnits = (actualGasCost + actualUserOpFeePerGas - 1) / actualUserOpFeePerGas;
        } else if (actualGasCost > 0) {
            gasUnits = 1;
        }

        totalGasUnitsProcessed += gasUnits;

        uint256 baseCharge = (actualGasCost * usdcPerWeiE6) / 1e18;
        if (baseCharge < minPostopFeeUsdcE6) {
            baseCharge = minPostopFeeUsdcE6;
        }

        uint256 referralAmount = (referralBps > 0 && referralAddress != address(0))
            ? (baseCharge * referralBps) / 10000
            : 0;
        uint256 treasuryAmount = baseCharge;
        uint256 referralPay = referralAmount;

        uint256 gasPriceContractWei = actualUserOpFeePerGas;

        _checkGasUsageLimits(sender, gasUnits);
        senderTotalGasUsed[sender] += gasUnits;
        senderOperationCount[sender] += 1;
        totalOperationsProcessed += 1;

        if (treasuryAmount > 0) {
            if (!usdc.transferFrom(sender, treasury, treasuryAmount)) revert UsdcTransferFromFailed();
        }
        if (referralPay > 0) {
            if (!usdc.transferFrom(sender, referralAddress, referralPay)) revert UsdcTransferFromFailed();
        }

        uint256 totalCharged = treasuryAmount + referralPay;

        if (referralPay > 0) {
            emit GasChargedWithReferral(
                sender,
                treasuryAmount,
                referralPay,
                totalCharged,
                referralAddress,
                referralBps,
                gasUnits,
                actualGasCost,
                gasPriceContractWei
            );
        } else {
            emit GasCharged(sender, totalCharged, baseCharge, treasury, gasUnits, actualGasCost, gasPriceContractWei);
        }
    }

    function _decodePaymasterData(bytes calldata paymasterAndData)
        internal
        pure
        returns (
            uint48 validUntil,
            uint48 validAfter,
            uint256 usdcPerWeiE6,
            uint256 minPostopFeeUsdcE6,
            uint256 estimatedNormalGasUnits,
            uint256 estimatedDeployGasUnits,
            address referralAddress,
            uint256 referralBps,
            uint8 capProfile,
            bytes memory sig
        )
    {
        if (paymasterAndData.length < PAYMASTER_AND_DATA_MIN_LENGTH) revert InvalidPaymasterData();

        bytes calldata trailing = paymasterAndData[52:];
        (
            validUntil,
            validAfter,
            usdcPerWeiE6,
            minPostopFeeUsdcE6,
            estimatedNormalGasUnits,
            estimatedDeployGasUnits,
            referralAddress,
            referralBps,
            capProfile,
            sig
        ) = abi.decode(trailing, (uint48, uint48, uint256, uint256, uint256, uint256, address, uint256, uint8, bytes));

        if (sig.length != 65) revert InvalidPaymasterData();
    }

    function _extractTarget(bytes calldata callData) internal pure returns (address target, bool supportedPattern) {
        if (callData.length < 36) return (address(0), false);

        bytes4 selector = bytes4(callData[:4]);
        if (selector != SIMPLE_ACCOUNT_EXECUTE_SELECTOR) return (address(0), false);

        (target,,) = abi.decode(callData[4:], (address, uint256, bytes));
        return (target, true);
    }

    function _packValidationData(uint48 validUntil, uint48 validAfter) internal pure returns (uint256) {
        return (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    function _buildPaymasterDigest(
        address sender,
        uint256 nonce,
        bytes calldata callData,
        address target,
        uint256 usdcPerWeiE6,
        uint256 minPostopFeeUsdcE6,
        uint256 estimatedNormalGasUnits,
        uint256 estimatedDeployGasUnits,
        uint48 validUntil,
        uint48 validAfter,
        address referralAddress,
        uint256 referralBps,
        uint8 capProfile
    ) internal view returns (bytes32) {
        return _toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    block.chainid,
                    address(this),
                    address(entryPoint),
                    sender,
                    nonce,
                    keccak256(callData),
                    target,
                    usdcPerWeiE6,
                    minPostopFeeUsdcE6,
                    estimatedNormalGasUnits,
                    estimatedDeployGasUnits,
                    validUntil,
                    validAfter,
                    referralAddress,
                    referralBps,
                    capProfile
                )
            )
        );
    }

    /// @dev v0.7 packed gasFees: high 128 bits = maxPriorityFeePerGas, low 128 bits = maxFeePerGas (viem / ERC-4337 packing).
    function _unpackMaxFeePerGas(bytes32 gasFees) internal pure returns (uint256) {
        return uint256(uint128(uint256(gasFees)));
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

    function _checkGasUsageLimits(address sender, uint256 gasUsed) internal {
        uint256 currentTime = block.timestamp;

        if (currentTime >= lastResetTimestamp + rateLimitPeriodSeconds) {
            lastResetTimestamp = currentTime;
            totalGasUsedThisPeriod = 0;
        }

        if (currentTime >= senderLastActivityTimestamp[sender] + rateLimitPeriodSeconds) {
            senderGasUsedThisPeriod[sender] = 0;
        }

        if (senderGasUsedThisPeriod[sender] + gasUsed > rateLimitMaxGasPerPeriod) {
            emit CircuitBreakerTriggered(sender, senderGasUsedThisPeriod[sender] + gasUsed, rateLimitMaxGasPerPeriod);
            paused = true;
            emit PausedUpdated(true);
            revert("Rate limit exceeded for sender");
        }

        if (totalGasUsedThisPeriod + gasUsed > circuitBreakerGasThreshold) {
            emit CircuitBreakerTriggered(address(0), totalGasUsedThisPeriod + gasUsed, circuitBreakerGasThreshold);
            paused = true;
            emit PausedUpdated(true);
            revert("Global gas usage circuit breaker triggered");
        }

        senderGasUsedThisPeriod[sender] += gasUsed;
        senderLastActivityTimestamp[sender] = currentTime;
        totalGasUsedThisPeriod += gasUsed;

        emit GasUsageTracked(sender, senderGasUsedThisPeriod[sender], totalGasUsedThisPeriod);
    }
}
