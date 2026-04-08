import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

const ENTRYPOINT_ADDRESS = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** 1 gwei - contract derives gas units from actualGasCost / actualUserOpFeePerGas */
const ONE_GWEI = 10n ** 9n;

/** PostOp context: (sender, usdcPerWeiE6, minPostopFeeUsdcE6, referralAddress, referralBps) */
function encodePostOpContext(
  sender: string,
  usdcPerWeiE6: bigint,
  minPostopFeeUsdcE6: bigint,
  referralAddress: string,
  referralBps: bigint
): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint256", "address", "uint256"],
    [sender, usdcPerWeiE6, minPostopFeeUsdcE6, referralAddress, referralBps]
  );
}

describe("Project4Paymaster postOp", function () {
  async function deployFixture() {
    const [owner, user, dappReferral] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();
    const Paymaster = await ethers.getContractFactory("Project4Paymaster");
    const pm = await Paymaster.deploy(
      ENTRYPOINT_ADDRESS,
      await usdc.getAddress(),
      owner.address,
      owner.address
    );
    await pm.waitForDeployment();
    const pmAddr = await pm.getAddress();
    await pm.setTreasury(pmAddr);
    await ethers.provider.send("hardhat_impersonateAccount", [ENTRYPOINT_ADDRESS]);
    await ethers.provider.send("hardhat_setBalance", [ENTRYPOINT_ADDRESS, "0x" + (1n * 10n ** 18n).toString(16)]);
    const entryPointSigner = await ethers.provider.getSigner(ENTRYPOINT_ADDRESS);
    return { owner, user, dappReferral, usdc, pm, pmAddr, entryPointSigner };
  }

  afterEach(async function () {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [ENTRYPOINT_ADDRESS]);
  });

  it("should charge USDC to treasury only when no referral (P4-CT-003)", async function () {
    const { user, usdc, pm, pmAddr, entryPointSigner } = await deployFixture();
    await usdc.mint(user.address, 10n * 10n ** 6n);

    const actualGasCost = 10n ** 14n;
    const actualUserOpFeePerGas = 10n ** 9n;
    const usdcPerWeiE6 = (1_000_000n * 10n ** 18n) / actualGasCost;
    const expectedCharge = (actualGasCost * usdcPerWeiE6) / 10n ** 18n;
    expect(expectedCharge).to.equal(1_000_000n);

    const minPostopFeeUsdcE6 = 10_000n;
    await usdc.connect(user).approve(await pm.getAddress(), 20n * 10n ** 6n);

    const context = encodePostOpContext(user.address, usdcPerWeiE6, minPostopFeeUsdcE6, ZERO_ADDRESS, 0n);

    const userBalBefore = await usdc.balanceOf(user.address);
    const treasuryBalBefore = await usdc.balanceOf(pmAddr);

    await pm.connect(entryPointSigner).postOp(0, context, actualGasCost, actualUserOpFeePerGas);

    expect(await usdc.balanceOf(user.address)).to.equal(userBalBefore - expectedCharge);
    expect(await usdc.balanceOf(pmAddr)).to.equal(treasuryBalBefore + expectedCharge);
  });

  it("should split charge between treasury and referral when referralBps > 0 (P4-CT-004)", async function () {
    const { user, dappReferral, usdc, pm, pmAddr, entryPointSigner } = await deployFixture();
    await usdc.mint(user.address, 10n * 10n ** 6n);

    const minPostopFeeUsdcE6 = 10_000n;
    const referralBps = 200n;
    const actualGasCost = 10n ** 14n;
    const actualUserOpFeePerGas = 10n ** 9n;
    const usdcPerWeiE6 = (1_000_000n * 10n ** 18n) / actualGasCost;
    const baseCharge = (actualGasCost * usdcPerWeiE6) / 10n ** 18n;
    const referralAmount = (baseCharge * referralBps) / 10000n;
    const totalCharge = baseCharge + referralAmount;

    await usdc.connect(user).approve(await pm.getAddress(), 20n * 10n ** 6n);

    const context = encodePostOpContext(
      user.address,
      usdcPerWeiE6,
      minPostopFeeUsdcE6,
      dappReferral.address,
      referralBps
    );

    const [userBalBefore, treasuryBalBefore, refBalBefore] = await Promise.all([
      usdc.balanceOf(user.address),
      usdc.balanceOf(pmAddr),
      usdc.balanceOf(dappReferral.address),
    ]);

    await pm.connect(entryPointSigner).postOp(0, context, actualGasCost, actualUserOpFeePerGas);

    expect(await usdc.balanceOf(user.address)).to.equal(userBalBefore - totalCharge);
    expect(await usdc.balanceOf(pmAddr)).to.equal(treasuryBalBefore + baseCharge);
    expect(await usdc.balanceOf(dappReferral.address)).to.equal(refBalBefore + referralAmount);
  });

  it("should charge same base to treasury with vs without referral (P4-CT-006)", async function () {
    const { user, dappReferral, usdc, pm, pmAddr, entryPointSigner } = await deployFixture();
    await usdc.mint(user.address, 20n * 10n ** 6n);

    const minPostopFeeUsdcE6 = 10_000n;
    const actualGasCost = 10n ** 14n;
    const usdcPerWeiE6 = (1_000_000n * 10n ** 18n) / actualGasCost;
    const baseCharge = (actualGasCost * usdcPerWeiE6) / 10n ** 18n;

    const contextNoRef = encodePostOpContext(user.address, usdcPerWeiE6, minPostopFeeUsdcE6, ZERO_ADDRESS, 0n);
    const contextWithRef = encodePostOpContext(
      user.address,
      usdcPerWeiE6,
      minPostopFeeUsdcE6,
      dappReferral.address,
      100n
    );

    await usdc.connect(user).approve(await pm.getAddress(), 40n * 10n ** 6n);

    await pm.connect(entryPointSigner).postOp(0, contextNoRef, actualGasCost, ONE_GWEI);
    const treasuryAfterNoRef = await usdc.balanceOf(pmAddr);

    await usdc.mint(user.address, 2n * 10n ** 6n);
    await pm.connect(entryPointSigner).postOp(0, contextWithRef, actualGasCost, ONE_GWEI);
    const treasuryAfterWithRef = await usdc.balanceOf(pmAddr);

    expect(treasuryAfterWithRef - treasuryAfterNoRef).to.equal(baseCharge);
  });

  it("should charge full base plus referral without max cap (P4-CT-007)", async function () {
    const { user, dappReferral, usdc, pm, pmAddr, entryPointSigner } = await deployFixture();
    await usdc.mint(user.address, 20n * 10n ** 6n);

    const minPostopFeeUsdcE6 = 10_000n;
    const referralBps = 500n;
    const actualGasCost = 10n ** 14n;
    const actualUserOpFeePerGas = ONE_GWEI;
    const usdcPerWeiE6 = (10_000_000n * 10n ** 18n) / actualGasCost;
    const baseCharge = (actualGasCost * usdcPerWeiE6) / 10n ** 18n;
    const referralAmount = (baseCharge * referralBps) / 10000n;
    const totalCharge = baseCharge + referralAmount;

    await usdc.connect(user).approve(await pm.getAddress(), totalCharge);

    const context = encodePostOpContext(
      user.address,
      usdcPerWeiE6,
      minPostopFeeUsdcE6,
      dappReferral.address,
      referralBps
    );

    const [userBalBefore, treasuryBalBefore, refBalBefore] = await Promise.all([
      usdc.balanceOf(user.address),
      usdc.balanceOf(pmAddr),
      usdc.balanceOf(dappReferral.address),
    ]);

    await pm.connect(entryPointSigner).postOp(0, context, actualGasCost, ONE_GWEI);

    expect(await usdc.balanceOf(user.address)).to.equal(userBalBefore - totalCharge);
    expect(await usdc.balanceOf(pmAddr)).to.equal(treasuryBalBefore + baseCharge);
    expect(await usdc.balanceOf(dappReferral.address)).to.equal(refBalBefore + referralAmount);
  });

  it("should apply min postop fee before referral add-on (P4-CT-008)", async function () {
    const { user, dappReferral, usdc, pm, pmAddr, entryPointSigner } = await deployFixture();
    await usdc.mint(user.address, 10n * 10n ** 6n);

    const usdcPerWeiE6 = 1n;
    const minPostopFeeUsdcE6 = 100_000n;
    const referralBps = 100n;
    const actualGasCost = 1000n;
    const actualUserOpFeePerGas = ONE_GWEI;
    const rawBase = (actualGasCost * usdcPerWeiE6) / 10n ** 18n;
    expect(rawBase).to.be.lt(minPostopFeeUsdcE6);
    const baseCharge = minPostopFeeUsdcE6;
    const referralAmount = (baseCharge * referralBps) / 10000n;
    const totalCharge = baseCharge + referralAmount;

    await usdc.connect(user).approve(await pm.getAddress(), totalCharge);

    const context = encodePostOpContext(
      user.address,
      usdcPerWeiE6,
      minPostopFeeUsdcE6,
      dappReferral.address,
      referralBps
    );

    const [userBalBefore, treasuryBalBefore, refBalBefore] = await Promise.all([
      usdc.balanceOf(user.address),
      usdc.balanceOf(pmAddr),
      usdc.balanceOf(dappReferral.address),
    ]);

    await pm.connect(entryPointSigner).postOp(0, context, actualGasCost, ONE_GWEI);

    expect(await usdc.balanceOf(user.address)).to.equal(userBalBefore - totalCharge);
    expect(await usdc.balanceOf(pmAddr)).to.equal(treasuryBalBefore + baseCharge);
    expect(await usdc.balanceOf(dappReferral.address)).to.equal(refBalBefore + referralAmount);
  });
});
