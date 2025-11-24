

#include "user_can.h"

uint8_t TPDO_Config_Status = 0;

//CAN过滤器配置
void CAN_ConfigFilter(void)
{
	CAN_FilterTypeDef CAN_FilterInitStructure;
	
	CAN_FilterInitStructure.FilterActivation = CAN_FILTER_ENABLE;//使能过滤器
	CAN_FilterInitStructure.FilterBank = 0;//过滤器索引号1
	CAN_FilterInitStructure.FilterFIFOAssignment = CAN_FILTER_FIFO0;//连接过滤器至FIFO0
	CAN_FilterInitStructure.FilterIdHigh = 0x0000;//过滤器识别标识符高位
	CAN_FilterInitStructure.FilterIdLow = 0x0000;//过滤器识别标识符低位
	CAN_FilterInitStructure.FilterMaskIdHigh = 0x0000;//过滤器掩码高位
	CAN_FilterInitStructure.FilterMaskIdLow = 0x0000;//过滤器掩码低位
	CAN_FilterInitStructure.FilterMode = CAN_FILTERMODE_IDMASK;//过滤器工作模式-屏蔽位模式
	CAN_FilterInitStructure.FilterScale = CAN_FILTERSCALE_32BIT;//过滤器扫描位数
/*	CAN1_Filter_Structure.SlaveStartFilterBank = 0;*/
	HAL_CAN_ConfigFilter(&hcan,&CAN_FilterInitStructure);

}

//CAN初始化配置
void CAN_Init(void)
{
	CAN_ConfigFilter();//CAN过滤器配置
	HAL_CAN_ActivateNotification(&hcan, CAN_IT_RX_FIFO0_MSG_PENDING);//使能CAN接收中断
	HAL_CAN_Start(&hcan);//开启CAN
}

//CAN标准帧发送函数
uint8_t CAN_Send(uint32_t ID, uint32_t Data_Size, uint8_t* Data)
{
	CAN_TxHeaderTypeDef CAN_TxHeader;
	uint32_t pTxMailbox = 1;
		
	CAN_TxHeader.DLC = Data_Size;	
	CAN_TxHeader.IDE = CAN_ID_STD;
	CAN_TxHeader.RTR = CAN_RTR_DATA;
	CAN_TxHeader.StdId = ID;
	
	return (HAL_CAN_AddTxMessage(&hcan,&CAN_TxHeader,Data,&pTxMailbox));
}


//CAN接收回调函数
void HAL_CAN_RxFifo0MsgPendingCallback(CAN_HandleTypeDef *hcan)
{
	
	CAN_RxHeaderTypeDef CAN_RxHeader;
	uint8_t	aData[8] = {0, 0, 0, 0, 0, 0, 0, 0};
	
	
	if(HAL_CAN_GetRxMessage(hcan, CAN_RX_FIFO0, &CAN_RxHeader, aData) != HAL_OK)
	{
		Error_Handler();
	}
	else if((CAN_RxHeader.StdId & 0x700) == 0x700)//接收到NMT报文，从机上线
	{
		TPDO_Config_Status = 1;
	}
}

//初始化控制
void ZLAC8015D_Test(void)
{
	switch(TPDO_Config_Status)
	{
		case 1:
		{
			RPDO0_Config(0x01);
			RPDO1_Config(0x01);
			RPDO2_Config(0x01);
			RPDO3_Config(0x01);
//			TPDO0_Config(0x01);
//			TPDO1_Config(0x01);
//			TPDO2_Config(0x01);
//			TPDO3_Config(0x01);
			Profile_Velocity_Init(0x01);
			NMT_Control(0x01, 0x01, 0x01);
			Driver_Enable(0x01);
			TPDO_Config_Status = 2;
			break;
		}
		case 2:
		{
			Profile_Velocity_Test(0x01);
			break;
		}
	}
}


//保存参数配置至EEPROM
uint8_t Save_EEPROM(uint8_t ID)
{
	uint8_t Data[8] = {0x2B, 0x10, 0x20, 0x00, 0x01, 0x00, 0x00, 0x00};
	return CAN_Send(0x600 + ID, 0x08, Data);
}

//恢复出厂配置
uint8_t Reset_Driver(uint8_t ID)
{
	uint8_t Data[8] = {0x2B, 0x09, 0x20, 0x00, 0x01, 0x00, 0x00, 0x00};
	return CAN_Send(0x600 + ID, 0x08, Data);
}

//RPDO事件触发
//RPDO0映射0x6040（控制字）
//RPDO0-COB-ID:0x200 + ID
uint8_t RPDO0_Config(uint8_t ID)
{
	uint8_t Data[8] = {0x2F, 0x00, 0x14, 0x02, 0xFE, 0x00, 0x00, 0x00};//RPDO0事件触发
	CAN_Send(0x600 + ID, 0x08, Data);
	HAL_Delay(5);

	Data[0] = 0x23;
	Data[1] = 0x00;
	Data[2] = 0x16;
	Data[3] = 0x01;
	Data[4] = 0x10;
	Data[5] = 0x00;
	Data[6] = 0x40;
	Data[7] = 0x60;
	CAN_Send(0x600 + ID, 0x08, Data);//RPDO0映射0x6040
	HAL_Delay(5);

	Data[0] = 0x2F;
	Data[1] = 0x00;
	Data[2] = 0x16;
	Data[3] = 0x00;
	Data[4] = 0x01;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//RPDO0开启1个映射
	HAL_Delay(5);

	return 0x00;
}

//RPDO1事件触发
//RPDO1映射0x60FF 03（目标速度）
//RPDO1-COB-ID:0x300 + ID
uint8_t RPDO1_Config(uint8_t ID)
{
	uint8_t Data[8];
	
	Data[0] = 0x2F;
	Data[1] = 0x01;
	Data[2] = 0x14;
	Data[3] = 0x02;
	Data[4] = 0xFE;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//RPDO1事件触发
	HAL_Delay(5);

	Data[0] = 0x23;
	Data[1] = 0x01;
	Data[2] = 0x16;
	Data[3] = 0x01;
	Data[4] = 0x20;
	Data[5] = 0x03;
	Data[6] = 0xFF;
	Data[7] = 0x60;
	CAN_Send(0x600 + ID, 0x08, Data);//RPDO1映射0x60FF 03
	HAL_Delay(5);
	
	Data[0] = 0x2F;
	Data[1] = 0x01;
	Data[2] = 0x16;
	Data[3] = 0x00;
	Data[4] = 0x01;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//RPDO1开启1个映射
	HAL_Delay(5);

	return 0x00;
}

//RPDO2事件触发
//RPDO2映射0x607A 01（左电机目标位置）
//RPDO2-COB-ID:0x400 + ID
uint8_t RPDO2_Config(uint8_t ID)
{
	uint8_t Data[8];
	
	Data[0] = 0x2F;
	Data[1] = 0x02;
	Data[2] = 0x14;
	Data[3] = 0x02;
	Data[4] = 0xFE;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//RPDO2事件触发
	HAL_Delay(5);

	Data[0] = 0x23;
	Data[1] = 0x02;
	Data[2] = 0x16;
	Data[3] = 0x01;
	Data[4] = 0x20;
	Data[5] = 0x01;
	Data[6] = 0x7A;
	Data[7] = 0x60;
	CAN_Send(0x600 + ID, 0x08, Data);//RPDO2映射0x607A 01
	HAL_Delay(5);
	
	Data[0] = 0x2F;
	Data[1] = 0x02;
	Data[2] = 0x16;
	Data[3] = 0x00;
	Data[4] = 0x01;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//RPDO2开启1个映射
	HAL_Delay(5);

	return 0x00;
}

//RPDO3事件触发
//RPDO3映射0x607A 02（右电机目标位置）
//RPDO3-COB-ID:0x500 + ID
uint8_t RPDO3_Config(uint8_t ID)
{
	uint8_t Data[8];
	
	Data[0] = 0x2F;
	Data[1] = 0x03;
	Data[2] = 0x14;
	Data[3] = 0x02;
	Data[4] = 0xFE;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//RPDO3事件触发
	HAL_Delay(5);

	Data[0] = 0x23;
	Data[1] = 0x03;
	Data[2] = 0x16;
	Data[3] = 0x01;
	Data[4] = 0x20;
	Data[5] = 0x02;
	Data[6] = 0x7A;
	Data[7] = 0x60;
	CAN_Send(0x600 + ID, 0x08, Data);//RPDO3映射0x607A 02
	HAL_Delay(5);
	
	Data[0] = 0x2F;
	Data[1] = 0x03;
	Data[2] = 0x16;
	Data[3] = 0x00;
	Data[4] = 0x01;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//RPDO3开启1个映射
	HAL_Delay(5);

	return 0x00;
}

//TPDO定时器触发
//TPDO0定时器100ms
//TPDO0映射0x606C 03（反馈速度）
//TPDO0-COB-ID:0x180 + ID
uint8_t TPDO0_Config(uint8_t ID)
{
	uint8_t Data[8];
	
	Data[0] = 0x2F;
	Data[1] = 0x00;
	Data[2] = 0x18;
	Data[3] = 0x02;
	Data[4] = 0xFF;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO0事件触发
	HAL_Delay(5);
	
	Data[0] = 0x2B;
	Data[1] = 0x00;
	Data[2] = 0x18;
	Data[3] = 0x05;
	Data[4] = 0xC8;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO0定时器200*0.5ms
	HAL_Delay(5);


	Data[0] = 0x23;
	Data[1] = 0x00;
	Data[2] = 0x1A;
	Data[3] = 0x01;
	Data[4] = 0x20;
	Data[5] = 0x03;
	Data[6] = 0x6C;
	Data[7] = 0x60;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO0映射0x606C 03
	HAL_Delay(5);

	Data[0] = 0x2F;
	Data[1] = 0x00;
	Data[2] = 0x1A;
	Data[3] = 0x00;
	Data[4] = 0x01;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO0开启1个映射
	HAL_Delay(5);

	return 0x00;
}

//TPDO1定时器触发
//TPDO1定时器100ms
//TPDO1映射0x6077 03(反馈电流)
//TPDO1-COB-ID:0x280 + ID
uint8_t TPDO1_Config(uint8_t ID)
{
	uint8_t Data[8];
	
	Data[0] = 0x2F;
	Data[1] = 0x01;
	Data[2] = 0x18;
	Data[3] = 0x02;
	Data[4] = 0xFF;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO1定时器触发
	HAL_Delay(5);
	
	Data[0] = 0x2B;
	Data[1] = 0x01;
	Data[2] = 0x18;
	Data[3] = 0x05;
	Data[4] = 0xC8;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDOA定时器200*0.5ms
	HAL_Delay(5);

	Data[0] = 0x23;
	Data[1] = 0x01;
	Data[2] = 0x1A;
	Data[3] = 0x01;
	Data[4] = 0x20;
	Data[5] = 0x03;
	Data[6] = 0x77;
	Data[7] = 0x60;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO1映射0x6077 03
	HAL_Delay(5);
	
	Data[0] = 0x2F;
	Data[1] = 0x01;
	Data[2] = 0x1A;
	Data[3] = 0x00;
	Data[4] = 0x01;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO1开启1个映射
	HAL_Delay(5);

	return 0x00;
}

//TPDO2定时器触发
//TPDO2定时器时间100ms
//TPDO2映射0x6064 01（左电机反馈位置）
//TPDO2映射0x6064 02（右电机反馈位置）
//TPDO2-COB-ID:0x380 + ID
uint8_t TPDO2_Config(uint8_t ID)
{
	uint8_t Data[8];
	
	Data[0] = 0x2F;
	Data[1] = 0x02;
	Data[2] = 0x18;
	Data[3] = 0x02;
	Data[4] = 0xFF;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO2事件触发
	HAL_Delay(5);
	
	Data[0] = 0x2B;
	Data[1] = 0x02;
	Data[2] = 0x18;
	Data[3] = 0x05;
	Data[4] = 0xC8;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO2定时器200*0.5ms
	HAL_Delay(5);


	Data[0] = 0x23;
	Data[1] = 0x02;
	Data[2] = 0x1A;
	Data[3] = 0x01;
	Data[4] = 0x20;
	Data[5] = 0x01;
	Data[6] = 0x64;
	Data[7] = 0x60;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO2映射0x6064 01
	HAL_Delay(5);
	
	Data[0] = 0x23;
	Data[1] = 0x02;
	Data[2] = 0x1A;
	Data[3] = 0x02;
	Data[4] = 0x20;
	Data[5] = 0x02;
	Data[6] = 0x64;
	Data[7] = 0x60;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO2映射0x6064 02
	HAL_Delay(5);

	
	Data[0] = 0x2F;
	Data[1] = 0x02;
	Data[2] = 0x1A;
	Data[3] = 0x00;
	Data[4] = 0x02;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO2开启2个映射
	HAL_Delay(5);

	return 0x00;
}

//TPDO3事件触发
//TPDO3映射0x603F 00（故障码）
//TPDO0禁止时间500ms
//TPDO3-COB-ID:0x480 + ID
uint8_t TPDO3_Config(uint8_t ID)
{
	uint8_t Data[8];
	
	Data[0] = 0x2F;
	Data[1] = 0x03;
	Data[2] = 0x18;
	Data[3] = 0x02;
	Data[4] = 0xFE;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO3事件触发
	HAL_Delay(5);

	Data[0] = 0x2B;
	Data[1] = 0x03;
	Data[2] = 0x18;
	Data[3] = 0x03;
	Data[4] = 0xE8;
	Data[5] = 0x03;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO3禁止时间1000*0.5ms
	HAL_Delay(5);

	
	Data[0] = 0x23;
	Data[1] = 0x03;
	Data[2] = 0x1A;
	Data[3] = 0x01;
	Data[4] = 0x20;
	Data[5] = 0x00;
	Data[6] = 0x3F;
	Data[7] = 0x60;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO3映射0x603F 00
	HAL_Delay(5);
	
	Data[0] = 0x2F;
	Data[1] = 0x03;
	Data[2] = 0x1A;
	Data[3] = 0x00;
	Data[4] = 0x01;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//TPDO3开启1个映射
	HAL_Delay(5);

	return 0x00;
}

//NMT发送
//写入0x01 0x01：开启1号驱动PDO传输
uint8_t NMT_Control(uint8_t ID, uint8_t Data0, uint8_t Data1)
{
	uint8_t Data[2] = {Data0, Data1};
	
	return CAN_Send(0x000, 0x02, Data);
}

//使能电机
uint8_t Driver_Enable(uint8_t ID)
{
	uint8_t Data_2Byte[2];
	
	Data_2Byte[0] = 0x06;
	Data_2Byte[1] = 0x00;
	CAN_Send(0x200 + ID, 0x02, Data_2Byte);
	
	Data_2Byte[0] = 0x07;
	Data_2Byte[1] = 0x00;
	CAN_Send(0x200 + ID, 0x02, Data_2Byte);
	HAL_Delay(5);
	
	Data_2Byte[0] = 0x0F;
	Data_2Byte[1] = 0x00;
	return CAN_Send(0x200 + ID, 0x02, Data_2Byte);
}
//速度模式初始化
uint8_t Profile_Velocity_Init(uint8_t ID)
{
	uint8_t Data[8] = {0x2F, 0x60, 0x60, 0x00, 0x03, 0x00, 0x00, 0x00};//设置速度模式
	CAN_Send(0x600 + ID, 0x08, Data);
	HAL_Delay(5);

	Data[0] = 0x23;
	Data[1] = 0x83;
	Data[2] = 0x60;
	Data[3] = 0x01;
	Data[4] = 0x64;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//设置左电机加速时间100ms
	HAL_Delay(5);
	
	Data[0] = 0x23;
	Data[1] = 0x83;
	Data[2] = 0x60;
	Data[3] = 0x02;
	Data[4] = 0x64;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//设置右电机加速时间100ms
	HAL_Delay(5);
	
	Data[0] = 0x23;
	Data[1] = 0x84;
	Data[2] = 0x60;
	Data[3] = 0x01;
	Data[4] = 0x64;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//设置左电机减速时间100ms
	HAL_Delay(5);

	Data[0] = 0x23;
	Data[1] = 0x84;
	Data[2] = 0x60;
	Data[3] = 0x02;
	Data[4] = 0x64;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//设置右电机减速时间100ms
	HAL_Delay(5);

	Data[0] = 0x2B;
	Data[1] = 0x0F;
	Data[2] = 0x20;
	Data[3] = 0x00;
	Data[4] = 0x01;
	Data[5] = 0x00;
	Data[6] = 0x00;
	Data[7] = 0x00;
	CAN_Send(0x600 + ID, 0x08, Data);//设置同步控制方式
	HAL_Delay(5);
	
	return 0x00;
}


//速度模式测试
void Profile_Velocity_Test(uint8_t ID)
{
	uint8_t Data_4Byte[4];
	
	Data_4Byte[0] = 0x64;
	Data_4Byte[1] = 0x00;
	Data_4Byte[2] = 0x64;
	Data_4Byte[3] = 0x00;
	CAN_Send(0x300 + ID, 0x04, Data_4Byte);//同步100rpm
	HAL_Delay(5000);
	
	Data_4Byte[0] = 0x9C;
	Data_4Byte[1] = 0xFF;
	Data_4Byte[2] = 0x9C;
	Data_4Byte[3] = 0xFF;
	CAN_Send(0x300 + ID, 0x04, Data_4Byte);//同步100rpm
	HAL_Delay(5000);
}


