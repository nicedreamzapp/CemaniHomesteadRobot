
#ifndef __USER_CAN_H__
#define __USER_CAN_H__

#include "can.h"
#include "ZLAC8015D.h"

extern uint8_t TPDO_Config_Status;

void CAN_ConfigFilter(void);
void CAN_Init(void);
uint8_t RPDO0_Config(uint8_t ID);//RPDO0≈‰÷√
uint8_t RPDO1_Config(uint8_t ID);//RPDO1≈‰÷√
uint8_t RPDO2_Config(uint8_t ID);//RPDO2≈‰÷√
uint8_t RPDO3_Config(uint8_t ID);//RPDO3≈‰÷√
uint8_t TPDO0_Config(uint8_t ID);//TPDO0≈‰÷√
uint8_t TPDO1_Config(uint8_t ID);//TPDO1≈‰÷√
uint8_t TPDO2_Config(uint8_t ID);//TPDO2≈‰÷√
uint8_t TPDO3_Config(uint8_t ID);//TPDO3≈‰÷√
uint8_t NMT_Control(uint8_t ID, uint8_t Data0, uint8_t Data1);//NMTøÿ÷∆
uint8_t Driver_Enable(uint8_t ID);// πƒ‹«–ªª
uint8_t Profile_Velocity_Init(uint8_t ID);//ÀŸ∂»ƒ£ Ω≥ı º≈‰÷√
void Profile_Velocity_Test(uint8_t ID);//ÀŸ∂»ƒ£ Ω≤‚ ‘
void ZLAC8015D_Test(void);//ZLAC8015D≤‚ ‘≥Ã–Ú

#endif
