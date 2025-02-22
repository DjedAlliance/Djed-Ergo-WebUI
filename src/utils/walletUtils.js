/* eslint no-undef: "off"*/
import { getTxUrl, getWalletAddress, getWalletType, isWalletSaved, showMsg } from './helpers';
import { encodeHex, encodeNum} from "./serializer";
import {Serializer} from "@coinbarn/ergo-ts/dist/serializer";
import { sigUsdTokenId } from './consts';
import { broadcast, getBankBox, getHeight, getOraclekBox, getTxFee } from './assembler';

let ergolib = import('ergo-lib-wasm-browser')

function walletDisconnect() {
    showMsg(`Disconnected from ${getWalletType()} wallet`, true)
    localStorage.removeItem('wallet');
}

// const setupYoroi = async () => {
//     const yoroiExists = window.ergo_request_read_access;

//     if (!yoroiExists) {
//         showMsg(`You should have the Yoroi wallet installed to be able to connect to it.`, true)
//         return null;
//     }
//     try {
//         const granted = await window.ergo_request_read_access();

//         if (granted) {
//             showMsg('Wallet access denied', true);
//             return;
//         }

//         const addr = await getConnectedAddress(tp, false)
//         showMsg(`Successfully connected to Yoroi`);
//         return addr
//     } catch(e) {
//         showMsg(`You should have the Yoroi wallet installed to be able to connect to it.`, true)
//     }
// }

// const setupNautilus = async () => {
//     const nautilusExists = window.ergoConnector?.nautilus?.connect;

//     if (!nautilusExists) {
//         showMsg(`You should have the Nautilus wallet installed to be able to connect to it.`, true)
//         return null;
//     }
//     try {
//         const granted = await window.ergoConnector?.nautilus?.connect();

//         if (granted) {
//             showMsg('Wallet access denied', true);
//             return;
//         }

//         const addr = await getConnectedAddress(tp, false);

//         showMsg(`Successfully connected to Nautilus`);

//         return addr
//     } catch(e) {
//         showMsg(`You should have the Nautilus wallet installed to be able to connect to it.`, true)
//     }
// }

export function boxToStrVal(box) {
    let newBox = JSON.parse(JSON.stringify(box))
    newBox.value = newBox.value.toString()
    if (newBox.assets === undefined) newBox.assets = []
    for (let i = 0; i < newBox.assets.length; i++) {
        newBox.assets[i].amount = newBox.assets[i].amount.toString()
    }
    return newBox
}


export async function walletCreate({need, req, getUtxos, signTx, submitTx, notif=true}) {
    const wasm = await ergolib

    const height = await getHeight()
    let bank = await getBankBox()
    console.log('bank', bank)
    bank = boxToStrVal(bank)
    let oracle = await getOraclekBox()
    oracle = boxToStrVal(oracle)
    req.requests = req.requests.map(box => {
        let newBox = boxToStrVal(box)
        newBox.creationHeight = height
        newBox.ergoTree = wasm.Address.from_mainnet_str(newBox.address).to_ergo_tree().to_base16_bytes()
        delete newBox.address
        if (newBox.registers) {
            newBox.additionalRegisters = newBox.registers
            delete newBox.registers
        }
        if (newBox.additionalRegisters === undefined) newBox.additionalRegisters = {}
        return newBox
    })
    
    let have = JSON.parse(JSON.stringify(need))
    let ins = [bank]
    const keys = Object.keys(have)

    for (let i = 0; i < keys.length; i++) {
        if (have[keys[i]] <= 0) continue
        const curIns = await getUtxos(have[keys[i]].toString(), keys[i]);
        if (curIns !== undefined) {
            curIns.forEach(bx => {
                have['ERG'] -= parseInt(bx.value)
                bx.assets.forEach(ass => {
                    if (!Object.keys(have).includes(ass.tokenId)) have[ass.tokenId] = 0
                    have[ass.tokenId] -= parseInt(ass.amount)
                })
            })
            ins = ins.concat(curIns)
        }
    }
    if (keys.filter(key => have[key] > 0).length > 0) {
        showMsg(`Not enough balance in the ${getWalletType()} wallet! See FAQ for more info.`, true)
        return
    }

    const feeBox = {
        value: req.fee.toString(),
        creationHeight: height,
        ergoTree: "1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304",
        assets: [],
        additionalRegisters: {},
    }

    const changeBox = {
        value: (-have['ERG']).toString(),
        ergoTree: wasm.Address.from_mainnet_str(getWalletAddress()).to_ergo_tree().to_base16_bytes(),
        assets: Object.keys(have).filter(key => key !== 'ERG')
            .filter(key => have[key] < 0)
            .map(key => {
                return {
                    tokenId: key,
                    amount: (-have[key]).toString()
                }
            }),
        additionalRegisters: {},
        creationHeight: height
    }

    const eins = ins.map(curIn => {
        return {
            ...curIn,
            extension: {}
        }
    })
    const unsigned = {
        inputs: eins,
        outputs: req.requests.concat([changeBox, feeBox]),
        dataInputs: [oracle],
        fee: req.fee
    }
    console.log('un', unsigned)

    let tx = null
    try {
        tx = await signTx(unsigned)
        console.log(tx)
    } catch (e) {
        showMsg(`Error while sending funds from ${getWalletType()}!`, true)
        console.log('error', e)
        return
    }
    let txId = undefined
    try {
        txId = (await broadcast(tx)).txId
    } catch (e) {
        txId = await submitTx(tx)
    }
    if (txId === undefined) {
        showMsg(`Error while sending funds using ${getWalletType()}!`, true)
        return
    }

    if (notif) {
        if (txId !== undefined && txId.length > 0)
            showMsg(`The operation is being done with ${getWalletType()}, please wait...`)
        else
            showMsg(`Error while sending funds using ${getWalletType()}!`, true)
    }
    return tx
}

export async function walletSendFunds({ need, addr, getUtxos, signTx, submitTx, registers={}, notif=true}) {
    const wasm = await ergolib

    const height = await getHeight()

    let have = JSON.parse(JSON.stringify(need))
    have['ERG'] += getTxFee()
    let ins = []
    const keys = Object.keys(have)

    for (let i = 0; i < keys.length; i++) {
        if (have[keys[i]] <= 0) continue
        const curIns = await getUtxos(have[keys[i]].toString(), keys[i]);
        if (curIns !== undefined) {
            curIns.forEach(bx => {
                have['ERG'] -= parseInt(bx.value)
                bx.assets.forEach(ass => {
                    if (!Object.keys(have).includes(ass.tokenId)) have[ass.tokenId] = 0
                    have[ass.tokenId] -= parseInt(ass.amount)
                })
            })
            ins = ins.concat(curIns)
        }
    }
    if (keys.filter(key => have[key] > 0).length > 0) {
        showMsg(`Not enough balance in the ${getWalletType()} wallet! See FAQ for more info.`, true)
        return
    }

    const fundBox = {
        value: need['ERG'].toString(),
        ergoTree: (await wasm).Address.from_mainnet_str(addr).to_ergo_tree().to_base16_bytes(),
        assets: keys.filter(key => key !== 'ERG').map(key => {
            return {
                tokenId: key,
                amount: need[key].toString()
            }
        }),
        additionalRegisters: registers,
        creationHeight: height
    }

    const feeBox = {
        value: getTxFee().toString(),
        creationHeight: height,
        ergoTree: "1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304",
        assets: [],
        additionalRegisters: {},
    }

    const changeBox = {
        value: (-have['ERG']).toString(),
        ergoTree: wasm.Address.from_mainnet_str(getWalletAddress()).to_ergo_tree().to_base16_bytes(),
        assets: Object.keys(have).filter(key => key !== 'ERG')
            .filter(key => have[key] < 0)
            .map(key => {
                return {
                    tokenId: key,
                    amount: (-have[key]).toString()
                }
            }),
        additionalRegisters: {},
        creationHeight: height
    }

    const eins = ins.map(curIn => {
        return {
            ...curIn,
            extension: {}
        }
    })
    const unsigned = {
        inputs: eins,
        outputs: [fundBox, changeBox, feeBox],
        dataInputs: [],
        fee: getTxFee()
    }
    console.log(unsigned)

    let tx = null
    try {
        tx = await signTx(unsigned)
    } catch (e) {
        showMsg(`Error while sending funds from ${getWalletType()}!`, true)
        console.log('error', e)
        return
    }
    // await submitTx(tx)
    const txId = (await broadcast(tx)).txId

    if (notif) {
        if (txId !== undefined && txId.length > 0)
            showMsg(`The operation is being done with ${getWalletType()}, please wait...`)
        else
            showMsg(`Error while sending funds using ${getWalletType()}!`, true)
    }
    return txId
}

export async function getDappBalance(tokenId) {
    await setupWallet(false, getWalletType())
    return await ergo.get_balance(tokenId)
}

// export async function getWalletTokens() {
//     await setupWallet()
//     const addresses = (await ergo.get_used_addresses()).concat(await ergo.get_unused_addresses())
//     let tokens = {}
//     for (let i = 0; i < addresses.length; i++) {
//         (await getBalance(addresses[i])).tokens.forEach(ass => {
//             if (!Object.keys(tokens).includes(ass.tokenId))
//                 tokens[ass.tokenId] = {
//                     amount: 0,
//                     name: ass.name,
//                     tokenId: ass.tokenId
//                 }
//             tokens[ass.tokenId].amount += parseInt(ass.amount)
//         })
//     }
//     return tokens
// }

