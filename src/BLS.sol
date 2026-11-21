// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title BLS: signature verification on BN254, using the EVM precompiles.
/// @notice Signatures are in G1 and public keys in G2. A message has exactly one valid signature for a
///         given key, which is what makes the hash of a signature usable as randomness. An ECDSA
///         signature would not do: its signer can make many valid ones and pick.
/// @dev node/src/bls.ts implements the same rules. Changing the domain, the encoding, the attempt cap
///      or the parity rule means a new protocol version.
library BLS {
    uint256 internal constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 internal constant SQRT_EXPONENT = (P + 1) / 4;
    uint256 internal constant MAX_ATTEMPTS = 128;
    string internal constant DOMAIN = "RANDOMNESS-ORACLE-BN254-G1-V1";

    // G2 generator in precompile order: x imaginary, x real, y imaginary, y real.
    uint256 private constant G2_X_IM = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 private constant G2_X_RE = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 private constant G2_Y_IM = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 private constant G2_Y_RE = 8495653923123431417604973247489272438418190587263600148770280649306958101930;

    /// @dev Order of G1 and G2: key shares and Lagrange coefficients are numbers modulo this.
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant MAX_SHARES = 16;

    address private constant MODEXP = address(5);
    address private constant EC_MUL = address(7);
    address private constant PAIRING = address(8);

    error HashToCurveFailed();

    /// @notice Try-and-increment: the first candidate x whose x^3 + 3 is a square, with the even y.
    function hashToG1(bytes32 message) internal view returns (uint256 x, uint256 y) {
        for (uint256 attempt; attempt < MAX_ATTEMPTS; attempt++) {
            x = uint256(keccak256(abi.encodePacked(DOMAIN, message, uint8(attempt)))) % P;
            uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), 3, P);
            y = _sqrtCandidate(rhs);
            if (mulmod(y, y, P) == rhs) {
                return (x, y & 1 == 0 ? y : P - y);
            }
        }
        revert HashToCurveFailed();
    }

    /// @notice Checks e(signature, -G2) * e(H(message), publicKey) == 1.
    /// @dev The precompile rejects coordinates >= P and points off the curve, so a signature has one encoding.
    function verify(uint256[4] memory publicKey, bytes32 message, uint256[2] memory signature)
        internal
        view
        returns (bool)
    {
        (uint256 hx, uint256 hy) = hashToG1(message);
        uint256[12] memory input = [
            signature[0],
            signature[1],
            G2_X_IM,
            G2_X_RE,
            P - G2_Y_IM,
            P - G2_Y_RE,
            hx,
            hy,
            publicKey[0],
            publicKey[1],
            publicKey[2],
            publicKey[3]
        ];
        (bool ok, bytes memory out) = PAIRING.staticcall(abi.encodePacked(input));
        return ok && out.length == 32 && abi.decode(out, (uint256)) == 1;
    }

    /// @notice True when the precompile accepts the key as a G2 point, and it is not infinity.
    function isValidPublicKey(uint256[4] memory publicKey) internal view returns (bool) {
        if (publicKey[0] | publicKey[1] | publicKey[2] | publicKey[3] == 0) return false;
        // The G1 point at infinity needs no pairing work, but the precompile still validates the G2 input.
        (bool ok,) = PAIRING.staticcall(abi.encode(uint256(0), uint256(0), publicKey));
        return ok;
    }

    /// @notice True when `shareKeys` are the public keys of a `threshold`-of-n split of `publicKey`: share i,
    ///         counted from 1, is f(i) for one polynomial f of degree threshold - 1 with f(0) the key. Any
    ///         `threshold` of such shares sign for the key together, and fewer do not determine it.
    /// @dev This is about public keys only. It cannot tell who holds the secret behind each one.
    function sharesMatchKey(uint256[4] memory publicKey, uint256[4][] memory shareKeys, uint256 threshold)
        internal
        view
        returns (bool)
    {
        uint256 n = shareKeys.length;
        if (threshold < 2 || threshold > n || n > MAX_SHARES) return false;
        for (uint256 i; i < n; i++) {
            if (!isValidPublicKey(shareKeys[i]) || _sameKey(shareKeys[i], publicKey)) return false;
            for (uint256 j; j < i; j++) {
                if (_sameKey(shareKeys[i], shareKeys[j])) return false;
            }
        }
        // The first `threshold` shares fix the polynomial. The key, at 0, and every later share must lie on it.
        if (!_interpolatesTo(shareKeys, threshold, 0, publicKey)) return false;
        // And one share fewer must not be enough, or the real threshold is lower than the one declared.
        if (threshold > 2 && _interpolatesTo(shareKeys, threshold - 1, 0, publicKey)) return false;
        for (uint256 k = threshold; k < n; k++) {
            if (!_interpolatesTo(shareKeys, threshold, k + 1, shareKeys[k])) return false;
        }
        return true;
    }

    /// @dev Checks sum(l_i * key_i) == target over the first `t` keys, with l_i the Lagrange coefficients at `x`.
    ///      G2 has no arithmetic precompile, so the sum is taken inside a pairing:
    ///      e(l_1 * G1, key_1) * ... * e(l_t * G1, key_t) * e(-G1, target) == 1.
    function _interpolatesTo(uint256[4][] memory keys, uint256 t, uint256 x, uint256[4] memory target)
        private
        view
        returns (bool)
    {
        uint256[] memory input = new uint256[]((t + 1) * 6);
        for (uint256 i; i < t; i++) {
            (uint256 gx, uint256 gy) = _mulGenerator(_lagrange(i + 1, t, x));
            _putPair(input, i * 6, gx, gy, keys[i]);
        }
        _putPair(input, t * 6, 1, P - 2, target);
        (bool ok, bytes memory out) = PAIRING.staticcall(abi.encodePacked(input));
        return ok && out.length == 32 && abi.decode(out, (uint256)) == 1;
    }

    function _putPair(uint256[] memory input, uint256 at, uint256 gx, uint256 gy, uint256[4] memory key) private pure {
        (input[at], input[at + 1]) = (gx, gy);
        (input[at + 2], input[at + 3], input[at + 4], input[at + 5]) = (key[0], key[1], key[2], key[3]);
    }

    /// @dev Lagrange coefficient of share `i` among shares 1..t, at `x`, modulo R.
    function _lagrange(uint256 i, uint256 t, uint256 x) private view returns (uint256) {
        uint256 numerator = 1;
        uint256 denominator = 1;
        for (uint256 j = 1; j <= t; j++) {
            if (j == i) continue;
            numerator = mulmod(numerator, addmod(x, R - j, R), R);
            denominator = mulmod(denominator, addmod(i, R - j, R), R);
        }
        // R is prime, so the inverse is a power.
        (bool ok, bytes memory out) = MODEXP.staticcall(abi.encode(32, 32, 32, denominator, R - 2, R));
        require(ok);
        return mulmod(numerator, abi.decode(out, (uint256)), R);
    }

    function _mulGenerator(uint256 scalar) private view returns (uint256 x, uint256 y) {
        (bool ok, bytes memory out) = EC_MUL.staticcall(abi.encode(uint256(1), uint256(2), scalar));
        require(ok);
        return abi.decode(out, (uint256, uint256));
    }

    function _sameKey(uint256[4] memory a, uint256[4] memory b) private pure returns (bool) {
        return a[0] == b[0] && a[1] == b[1] && a[2] == b[2] && a[3] == b[3];
    }

    function _sqrtCandidate(uint256 value) private view returns (uint256) {
        (bool ok, bytes memory out) = MODEXP.staticcall(abi.encode(32, 32, 32, value, SQRT_EXPONENT, P));
        require(ok);
        return abi.decode(out, (uint256));
    }
}
