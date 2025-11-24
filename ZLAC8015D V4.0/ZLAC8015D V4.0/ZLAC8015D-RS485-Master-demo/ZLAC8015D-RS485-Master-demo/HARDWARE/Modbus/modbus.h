#ifndef __MODBUS_H__
#define __MODBUS_H__

#define MB_SLAVEADDR1        0x0001
#define MB_SLAVEADDR2        0x0002



uint16_t MB_CRC16(uint8_t *pushMsg,uint8_t usDataLen);
void MB_ReadHoldingReg_03H(uint8_t _addr, uint16_t _reg, uint16_t _num);
void MB_WriteHoldingReg_06H(uint8_t _addr, uint16_t _reg, uint16_t _data);
void MB_WriteNumHoldingReg_10H(uint8_t _addr, uint16_t _reg, uint16_t _num,uint8_t *_databuf);

#endif
