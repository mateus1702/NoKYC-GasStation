import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();


const ENTRYPOINT_ADDRESS = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const FIXED_CHARGE_E6 = 1_000_000n; // 1 USDC (6 decimals)

describe("Project4Paymaster postOp", function () {
  it("should charge fixed USDC in postOp when called by EntryPoint", async function () {
    const [owner, user] = await ethers.getSigners();

    // Deploy Mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    // Mint 10 USDC to user, approve paymaster
    await usdc.mint(user.address, 10n * 10n ** 6n);

    const Paymaster = await ethers.getContractFactory("Project4Paymaster");
    const pm = await Paymaster.deploy(
      ENTRYPOINT_ADDRESS,
      await usdc.getAddress(),
      owner.address,
      owner.address
    );
    await pm.waitForDeployment();

    await usdc.connect(user).approve(await pm.getAddress(), FIXED_CHARGE_E6);

    // Impersonate EntryPoint so we can call postOp
    await ethers.provider.send("hardhat_impersonateAccount", [ENTRYPOINT_ADDRESS]);
    await ethers.provider.send("hardhat_setBalance", [ENTRYPOINT_ADDRESS, "0x" + (1n * 10n ** 18n).toString(16)]);

    const entryPointSigner = await ethers.provider.getSigner(ENTRYPOINT_ADDRESS);

    const userBalanceBefore = await usdc.balanceOf(user.address);
    const treasuryBalanceBefore = await usdc.balanceOf(owner.address);

    const context = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [user.address, FIXED_CHARGE_E6]
    );

    // PostOpMode.opSucceeded = 0
    await pm.connect(entryPointSigner).postOp(
      0, // PostOpMode.opSucceeded
      context,
      100_000n, // actualGasCost
      0n // actualUserOpFee
    );

    const userBalanceAfter = await usdc.balanceOf(user.address);
    const treasuryBalanceAfter = await usdc.balanceOf(owner.address);

    expect(userBalanceAfter).to.equal(userBalanceBefore - FIXED_CHARGE_E6);
    expect(treasuryBalanceAfter).to.equal(treasuryBalanceBefore + FIXED_CHARGE_E6);

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [ENTRYPOINT_ADDRESS]);
  });
});
